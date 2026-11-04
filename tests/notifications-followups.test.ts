import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
import {database,readyLead,readyDraft,testSettings,mockGoogle} from './helpers';
import {fixtureUseCase,mockOpenAI} from './openai-fixture';
import {all,one,run,now} from '../src/db';
import {ingestMessage,sendApproved} from '../src/mail';
import {tick,processAvailableJobs} from '../src/engine';
import {notificationPage,readNotifications,notifyInApp} from '../src/notifications';
import {saveProduct,scopeProduct} from '../src/products';
import {prospectPage} from '../src/prospects';
import {validateSettings} from '../src/policy';
import {approvalHash} from '../src/policy';
import worker from '../src/index';

const origin='https://outreach.example.com',ctx={waitUntil:()=>{}} as unknown as ExecutionContext;
const message=(id:string,classification='reply')=>({id,threadId:'thread',payload:{headers:[{name:'From',value:classification==='bounce'?'Mailer-Daemon@example.com':'Buyer <buyer@pumps.example.com>'},{name:'Subject',value:classification==='automatic'?'Out of office':classification==='bounce'?'Delivery failure':'A question about the product'},{name:'Message-ID',value:`<${id}@example.com>`}],mimeType:'text/plain',body:{data:Buffer.from(classification==='optout'?'Please unsubscribe me':classification==='bounce'?'Recipient address does not exist':classification==='automatic'?'Away until Monday':'Can you explain how this fits our quotation workflow?').toString('base64url')}}});
async function req(env:any,path:string,payload?:any,cookie?:string,from=origin){return worker.fetch(new Request(origin+path,{method:payload===undefined?'GET':'POST',headers:{Origin:from,'X-Requested-With':'Prepyr',...(cookie?{Cookie:cookie}:{})},...(payload===undefined?{}:{body:JSON.stringify(payload)})}),env,ctx);}
async function login(env:any){const r=await req(env,'/api/login',{password:env.ADMIN_PASSWORD});return r.headers.get('set-cookie')!.split(';')[0];}

for(const kind of ['reply','automatic','bounce','optout'])test(`${kind} updates prospect state, stops follow-ups and emits exactly one persistent notification`,async()=>{
 const {env,close}=database();try{
  const lead=await readyLead(env),draft=await readyDraft(env,lead);await run(env,"UPDATE drafts SET kind='followup' WHERE id=?",draft.id);await run(env,"UPDATE leads SET status='contacted',next_followup_at=? WHERE id=?",now(),lead.id);
  await run(env,"INSERT INTO jobs(id,kind,lead_id,state,created_at,updated_at) VALUES('running','followup',?,'running',?,?)",lead.id,now(),now());
  await ingestMessage(env,lead,message(kind,kind));await ingestMessage(env,lead,message(kind,kind));
  const fresh=await one<any>(env,'SELECT * FROM leads WHERE id=?',lead.id);assert.equal(fresh.next_followup_at,null);assert.ok(fresh.last_inbound_at);assert.equal(fresh.status,kind==='bounce'?'bounced':kind==='optout'?'suppressed':kind==='automatic'?'automatic':'replied');
  assert.equal((await one<any>(env,'SELECT state FROM jobs WHERE id=\'running\'')).state,'cancelled');assert.equal((await one<any>(env,'SELECT status FROM drafts WHERE id=?',draft.id)).status,'cancelled');
  const feed:any=await notificationPage(env);assert.equal(feed.unread,1);assert.equal(feed.items.length,1);assert.equal(feed.items[0].kind,kind);assert.equal(feed.items[0].lead_id,lead.id);
  await readNotifications(env,{id:feed.items[0].id});assert.equal((await notificationPage(env)).unread,0);assert.ok((await notificationPage(env)).items[0].read_at);
 }finally{close();}
});

test('notifications aggregate product-specific events without mixing conversations and require authentication and same-origin writes',async()=>{
 const {env,close}=database();try{
  const legacy=await readyLead(env);await ingestMessage(env,legacy,message('same-id'));
  const p=await saveProduct(env,{name:'QuoteFlow',website:'https://pumps.example.com',description:'A quote workflow',sender_email:'data@prepyr.com'}),scope=await scopeProduct(env,p),lead=await readyLead(scope);
  await ingestMessage(scope,lead,message('same-id'));
  assert.equal((await notificationPage(env)).unread,2);assert.equal((await one<any>(scope,'SELECT count(*) n FROM app_notifications')).n,0);
  assert.equal((await req(env,'/api/notifications')).status,401);const cookie=await login(env);
  const feed:any=await(await req(env,'/api/notifications?product='+p.id,undefined,cookie)).json();assert.equal(feed.items.length,2);assert.equal(feed.items.find((n:any)=>n.product_id===p.id).lead_id,lead.id);
  assert.equal((await req(env,'/api/notifications/read',{all:true},cookie,'https://evil.example')).status,403);assert.equal((await notificationPage(env)).unread,2);
  assert.equal((await req(env,'/api/notifications/read',{all:true},cookie)).status,200);assert.equal((await notificationPage(env)).unread,0);
 }finally{close();}
});

test('three automatic follow-up drafts require approval, respect future due dates, use numbered conversation context and stop after number three',async()=>{
 const {env,close}=database(),original=globalThis.fetch,{fetcher,calls}=mockOpenAI();let sends=0;
 Object.assign(env,{OPENAI_API_KEY:'test',ENABLE_AUTOMATION:'true',ENABLE_SENDING:'true',GOOGLE_CLIENT_ID:'test',GOOGLE_CLIENT_SECRET:'test',GOOGLE_REFRESH_TOKEN:'test'});
 const google=mockGoogle(()=>Response.json({id:'sent-'+(++sends),threadId:'thread'}));globalThis.fetch=((url:any,init:any)=>String(url).includes('api.openai.com')?fetcher(url,init):google(url,init)) as typeof fetch;
 try{
  await run(env,'INSERT INTO settings(id,data) VALUES(1,?)',JSON.stringify({...testSettings,discoveryPausedUntil:new Date(Date.now()+3*86400000).toISOString()}));
  const lead=await readyLead(env),initial=await readyDraft(env,lead);await sendApproved(env,testSettings);assert.equal(sends,1);const cookie=await login(env);
  for(let n=1;n<=3;n++){
   for(let i=0;i<3;i++)await tick(env);assert.equal(sends,n,'drafting never auto-approves or sends');
   const d=await one<any>(env,"SELECT * FROM drafts WHERE lead_id=? AND kind='followup' AND status='pending'",lead.id);assert.ok(d,`follow-up ${n} ready`);assert.ok(d.send_after);assert.equal(d.approved_hash,null);
   const p:any=await prospectPage(env,new URL(origin+'/api/prospects'));assert.equal(p.rows[0].draft_kind,'followup');assert.equal(p.rows[0].draft_id,d.id);
   const approval=await req(env,`/api/drafts/${d.id}/approve`,{version:d.version,evidenceReviewed:true,contactReviewed:true},cookie);assert.equal(approval.status,200);assert.equal((await approval.json() as any).status,'approved');assert.equal(sends,n,'future follow-up cannot send early');
   await run(env,"UPDATE leads SET next_followup_at=? WHERE id=?",new Date(Date.now()-1000).toISOString(),lead.id);await run(env,"UPDATE drafts SET send_after=? WHERE id=?",new Date(Date.now()-1000).toISOString(),d.id);
   await sendApproved(env,testSettings);assert.equal(sends,n+1);assert.equal((await one<any>(env,'SELECT followup_count FROM leads WHERE id=?',lead.id)).followup_count,n);
  }
  for(let i=0;i<3;i++)await tick(env);assert.equal((await one<any>(env,'SELECT next_followup_at FROM leads WHERE id=?',lead.id)).next_followup_at,null);assert.equal((await all(env,"SELECT * FROM drafts WHERE kind='followup'")).length,3);
  const prompts=calls.filter(c=>c.text?.format?.name==='relay_draft_generate');assert.deepEqual(prompts.map(c=>JSON.parse(c.input).followupNumber),[1,2,3]);assert.ok(prompts.every(c=>c.instructions.includes('third follow-up')));
  assert.equal((await notificationPage(env)).items.filter((n:any)=>n.kind==='followup_ready').length,3);assert.throws(()=>validateSettings({...testSettings,followupDays:[4,10,18,24]}));
 }finally{globalThis.fetch=original;close();}
});

test('a reply arriving during paid follow-up generation cancels the work and cannot leave a sendable follow-up',async()=>{
 const {env,close}=database(),original=globalThis.fetch,{fetcher}=mockOpenAI();env.OPENAI_API_KEY='test';let interrupted=false;
 try{
  const lead=await readyLead(env);await run(env,"UPDATE leads SET status='contacted',next_followup_at=? WHERE id=?",now(),lead.id);await run(env,"INSERT INTO jobs(id,kind,lead_id,created_at,updated_at) VALUES('followup','followup',?,?,?)",lead.id,now(),now());
  globalThis.fetch=(async(url:any,init:any)=>{const r=await fetcher(url,init);if(!interrupted&&JSON.parse(init.body).text?.format?.name==='relay_draft_assess'){interrupted=true;await ingestMessage(env,lead,message('during-generation'));}return r;}) as typeof fetch;
  for(let i=0;i<3;i++)await processAvailableJobs(env);
  assert.ok(interrupted);assert.equal((await all(env,"SELECT * FROM drafts WHERE kind='followup'")).length,0);assert.equal((await one<any>(env,"SELECT state FROM jobs WHERE id='followup'")).state,'cancelled');assert.equal((await notificationPage(env)).unread,1);
 }finally{globalThis.fetch=original;close();}
});

for(const stoppedBy of ['fresh thread reply','third follow-up cap'])test(`dispatch cannot send a follow-up past the ${stoppedBy}`,async()=>{
 const {env,close}=database(),original=globalThis.fetch;let sends=0;Object.assign(env,{ENABLE_SENDING:'true',GOOGLE_CLIENT_ID:'test',GOOGLE_CLIENT_SECRET:'test',GOOGLE_REFRESH_TOKEN:'test'});
 const google=mockGoogle(()=>{sends++;return Response.json({id:'must-not-send',threadId:'thread'});});globalThis.fetch=((url:any,init:any)=>String(url).includes('threads/')?Promise.resolve(Response.json({messages:stoppedBy==='fresh thread reply'?[message('before-send')]:[]})):google(url,init)) as typeof fetch;
 try{
  const lead=await readyLead(env);await run(env,"UPDATE leads SET status='contacted',thread_id='thread',next_followup_at=?,followup_count=? WHERE id=?",new Date(Date.now()-1000).toISOString(),stoppedBy==='third follow-up cap'?3:0,lead.id);
  const fresh=await one<any>(env,'SELECT * FROM leads WHERE id=?',lead.id),draft=await readyDraft(env,fresh);draft.kind='followup';await run(env,"UPDATE drafts SET kind='followup',approved_hash=? WHERE id=?",await approvalHash(draft,fresh,testSettings,env.SENDER_EMAIL!),draft.id);
  await sendApproved(env,testSettings);assert.equal(sends,0);assert.notEqual((await one<any>(env,'SELECT status FROM drafts WHERE id=?',draft.id)).status,'sent');
  if(stoppedBy==='fresh thread reply'){assert.equal((await notificationPage(env)).unread,1);assert.equal((await one<any>(env,'SELECT next_followup_at FROM leads WHERE id=?',lead.id)).next_followup_at,null);}
 }finally{globalThis.fetch=original;close();}
});

test('product follow-ups use the approved product, owner remarks, sequence number and shared notification inbox',async()=>{
 const {env,close}=database(),original=globalThis.fetch,{fetcher,calls}=mockOpenAI();env.OPENAI_API_KEY='test';globalThis.fetch=fetcher;
 try{
  const p=await saveProduct(env,{name:'QuoteFlow',website:'https://pumps.example.com',description:'Collect flange specifications before quoting',remarks:'Do not offer free trials',sender_email:'data@prepyr.com'});
  await run(env,"UPDATE products SET state='approved',approved_revision=revision,analysis=? WHERE id=?",JSON.stringify({useCases:[fixtureUseCase]}),p.id);const scope=await scopeProduct(env,{...p,state:'approved',approved_revision:p.revision,analysis:JSON.stringify({useCases:[fixtureUseCase]})}),lead=await readyLead(scope);await run(scope,"UPDATE settings SET data=json_set(data,'$.prospectingPaused',json('false'))");
  await run(scope,"UPDATE leads SET status='contacted',next_followup_at=? WHERE id=?",new Date(Date.now()+4*86400000).toISOString(),lead.id);await run(scope,"INSERT INTO jobs(id,kind,lead_id,created_at,updated_at) VALUES('product-followup','followup',?,?,?)",lead.id,now(),now());
  for(let i=0;i<5;i++)await processAvailableJobs(scope);
  const draft=await one<any>(scope,"SELECT * FROM drafts WHERE kind='followup'");assert.ok(draft);assert.equal(draft.status,'pending');assert.equal(draft.approved_hash,null);assert.ok(draft.send_after);
  const prompt=calls.find(c=>c.text?.format?.name==='relay_draft_generate');assert.equal(JSON.parse(prompt.input).followupNumber,1);assert.ok(prompt.instructions.includes('Do not offer free trials'));assert.ok(prompt.instructions.includes('third follow-up'));
  const feed=await notificationPage(env);assert.equal(feed.items[0].product_id,p.id);assert.equal(feed.items[0].draft_id,draft.id);
 }finally{globalThis.fetch=original;close();}
});

test('a deliberately retried incomplete assessment reuses completed draft output and repairs only the bounded assessment stage',async()=>{
 const {env,close}=database(),original=globalThis.fetch,{fetcher,calls}=mockOpenAI();env.OPENAI_API_KEY='test';let truncated=false;
 globalThis.fetch=(async(url:any,init:any)=>{const request=JSON.parse(init.body),r=await fetcher(url,init);if(request.text?.format?.name==='relay_draft_assess'&&!truncated){truncated=true;const data:any=await r.json();return Response.json({...data,status:'incomplete',incomplete_details:{reason:'max_output_tokens'},output:[{type:'message',content:[{type:'output_text',text:'{"specific":'}]}]});}return r;}) as typeof fetch;
 try{
  const lead=await readyLead(env);await run(env,"UPDATE leads SET status='contacted',next_followup_at=? WHERE id=?",now(),lead.id);await run(env,"INSERT INTO jobs(id,kind,lead_id,created_at,updated_at) VALUES('repair-followup','followup',?,?,?)",lead.id,now(),now());
  for(let i=0;i<3;i++)await processAvailableJobs(env);assert.equal((await one<any>(env,"SELECT state FROM jobs WHERE id='repair-followup'")).state,'failed');const completedCalls=calls.length;
  const cookie=await login(env);assert.equal((await req(env,'/api/jobs/repair-followup/retry',{confirmPaidRetry:true},cookie)).status,200);
  await processAvailableJobs(env);assert.equal((await one<any>(env,"SELECT state FROM jobs WHERE id='repair-followup'")).state,'complete');assert.equal(calls.length,completedCalls+1);const repair=calls.at(-1);assert.equal(repair.text.format.name,'relay_draft_assess_repair');assert.equal(repair.max_output_tokens,1600);assert.equal(repair.tools,undefined);
  assert.equal((await all(env,"SELECT * FROM drafts WHERE kind='followup'")).length,1);assert.equal((await notificationPage(env)).unread,1);assert.equal((await all(env,"SELECT * FROM expenses WHERE state<>'settled'")).length,0);
 }finally{globalThis.fetch=original;close();}
});

test('improving a held follow-up preserves its kind, due date and sequence and supplies the quality issue to OpenAI',async()=>{
 const {env,close}=database(),original=globalThis.fetch,{fetcher,calls}=mockOpenAI();env.OPENAI_API_KEY='test';globalThis.fetch=fetcher;
 try{
  const lead=await readyLead(env),draft=await readyDraft(env,lead),due=new Date(Date.now()+4*86400000).toISOString();await run(env,"UPDATE leads SET status='contacted',next_followup_at=? WHERE id=?",due,lead.id);await run(env,"UPDATE drafts SET kind='followup',status='pending',quality_hold='Do not assume access to order status',send_after=? WHERE id=?",due,draft.id);
  const background=await readyLead(env,{company:'Background research',website:'https://background.example.com',email:'team@background.example.com'});await run(env,"INSERT INTO jobs(id,kind,lead_id,created_at,updated_at) VALUES('background','research',?,'2026-01-01T00:00:00.000Z',?)",background.id,now());
  const cookie=await login(env);assert.equal((await req(env,`/api/drafts/${draft.id}/rewrite`,{version:1},cookie)).status,200);for(let i=0;i<3;i++)await processAvailableJobs(env);assert.equal((await one<any>(env,"SELECT attempts FROM jobs WHERE id='background'")).attempts,0);
  const updated=await one<any>(env,'SELECT * FROM drafts WHERE id=?',draft.id);assert.equal(updated.kind,'followup');assert.equal(updated.version,2);assert.equal(updated.send_after,due);assert.equal(updated.approved_hash,null);assert.equal(updated.quality_hold,'');assert.equal((await all(env,'SELECT * FROM drafts')).length,1);
  const input=JSON.parse(calls.find(c=>c.text?.format?.name==='relay_draft_generate').input);assert.equal(input.kind,'followup');assert.equal(input.followupNumber,1);assert.equal(input.revisionRequest.qualityHold,'Do not assume access to order status');assert.equal((await one<any>(env,'SELECT followup_count FROM leads WHERE id=?',lead.id)).followup_count,0);
 }finally{globalThis.fetch=original;close();}
});

test('real notification dropdown shows escaped previews, persists read state and opens the correct prospect conversation',async()=>{
 const {env,close}=database();let dom:JSDOM|undefined;try{
  const lead=await readyLead(env),draft=await readyDraft(env,lead);await run(env,"UPDATE drafts SET status='sent' WHERE id=?",draft.id);await ingestMessage(env,lead,message('ui-reply'));await notifyInApp(env,{key:'escaped',kind:'reply',leadId:lead.id,title:'<img src=x onerror=alert(1)>',body:'<script>bad()</script>'});const cookie=await login(env);
  dom=new JSDOM(fs.readFileSync('public/index.html','utf8'),{url:origin,runScripts:'outside-only'});const doc=dom.window.document;(dom.window.HTMLDialogElement.prototype as any).showModal=function(){this.open=true;};(dom.window.HTMLDialogElement.prototype as any).close=function(){this.open=false;};
  (dom.window as any).fetch=(path:string,init:any)=>worker.fetch(new Request(origin+path,{...init,headers:{...init.headers,Origin:origin,Cookie:cookie}}),env,ctx);dom.window.eval(fs.readFileSync('public/app.js','utf8'));
  async function until(fn:()=>boolean){for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('UI timeout');}
  await until(()=>doc.querySelector('#notification-count')!.textContent==='2'&&!!doc.querySelector('table'));(doc.querySelector('#notification-toggle') as HTMLElement).click();await until(()=>!(doc.querySelector('#notification-panel') as HTMLElement).hidden);
  assert.equal(doc.querySelector('#notification-list img'),null);assert.equal(doc.querySelector('#notification-list script'),null);assert.match(doc.querySelector('table')!.textContent!,/Reply received/);
  const button=[...doc.querySelectorAll('[data-notification]')].find(b=>b.textContent?.includes('Reply received')) as HTMLElement;button.click();await until(()=>!!doc.querySelector('#draft-form'));assert.equal((doc.querySelector('#modal') as HTMLDialogElement).open,true);assert.match(doc.querySelector('#modal-content')!.textContent!,/quotation workflow/);assert.equal((await notificationPage(env)).unread,1);
  (doc.querySelector('#notifications-read-all') as HTMLElement).click();await until(()=>doc.querySelector('#notification-count')!.textContent==='0');assert.equal((await notificationPage(env)).unread,0);
 }finally{dom?.window.close();close();}
});
