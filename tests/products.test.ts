import {emailStyleInstructions} from '../src/email-style';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index';
import {database,readyLead,readyDraft,testSettings,mockGoogle} from './helpers';
import {mockOpenAI} from './openai-fixture';
import {all,one,run,settings,month,day,now,claimResearchBusiness,BudgetPaused} from '../src/db';
import {saveProduct,product,productList,productDetail,scopeProduct,queueProductAnalysis,advanceProductAnalysis,approveProduct} from '../src/products';
import {startDiscovery,importLead} from '../src/discovery';
import {tick,scheduleResearch} from '../src/engine';
import {openai} from '../src/providers';
import {sendApproved,suppress,unsubscribeUrl,syncInbox} from '../src/mail';
import {isD1Unavailable} from '../src/workspace-backup';
import {containsExcerpt} from '../src/evidence';

const input={name:'FlangeFlow',website:'https://pumps.example.com',description:'A product that collects pump specifications for quotation requests',remarks:'Prioritize flange specification workflows; do not offer free trials',sender_email:'data@prepyr.com'};
async function approved(env:any,name=input.name){
 const p=await saveProduct(env,{...input,name});await queueProductAnalysis(env,p.id);
 for(let i=0;i<5;i++){const fresh=await product(env,p.id);if(fresh.state!=='analyzing')break;await advanceProductAnalysis(env,fresh);}
 const review=await product(env,p.id);assert.equal(review.state,'approved');await approveProduct(env,p.id,review.revision);await run(await scopeProduct(env,await product(env,p.id)),"UPDATE settings SET data=json_set(data,'$.discoveryPaused',json('false'),'$.prospectingPaused',json('false'))");return product(env,p.id);
}
async function req(env:any,path:string,body?:any,cookie?:string){return worker.fetch(new Request('https://outreach.example.com'+path,{method:body===undefined?'GET':'POST',headers:{Origin:'https://outreach.example.com','X-Requested-With':'Prepyr',...(cookie?{Cookie:cookie}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})}),env,{waitUntil:()=>{}} as unknown as ExecutionContext);}
async function login(env:any){const r=await req(env,'/api/login',{password:env.ADMIN_PASSWORD});return r.headers.get('set-cookie')!.split(';')[0];}

test('product analysis uses screenshots and remarks, and profile is automatically applied before a requested prospect search',async()=>{
 const {env,close}=database();env.OPENAI_API_KEY='fixture';const original=globalThis.fetch,{fetcher,calls}=mockOpenAI();globalThis.fetch=fetcher;
 try{
  const p=await saveProduct(env,{...input,images:[{name:'Product screen',data:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4XsAAAAASUVORK5CYII='}]});
  let scoped=await scopeProduct(env,p);await assert.rejects(startDiscovery(scoped,await settings(scoped)),/profile is not ready/i);assert.equal(calls.length,0);
  await queueProductAnalysis(env,p.id);await advanceProductAnalysis(env,await product(env,p.id));await advanceProductAnalysis(env,await product(env,p.id));
  const review=await product(env,p.id);assert.equal(review.state,'approved');assert.equal(calls.length,2);assert.ok(calls[1].instructions.includes('Apply the same qualification standard'));assert.ok(calls[1].instructions.includes('Buying willingness, authority, budget and internal CSV/Excel file formats are unknown'));
  assert.ok(Array.isArray(calls[1].input));assert.equal(calls[1].input[0].content[1].type,'input_image');assert.ok(calls.every(c=>c.instructions.includes(input.remarks)));
  await assert.rejects(approveProduct(env,p.id,99),/profile/);await approveProduct(env,p.id,review.revision);scoped=await scopeProduct(env,await product(env,p.id));
  const s=await settings(scoped);assert.equal(s.dailyResearchLimit,60);assert.equal(s.dailyTotalLimit,12);assert.equal(s.openaiBudget,50);assert.equal(s.campaigns[0].query,'industrial pump flange suppliers');
  assert.equal((await all(scoped,'SELECT * FROM messages')).length,0);assert.equal((await productDetail(env,p.id)).images.length,1);
 }finally{globalThis.fetch=original;close();}
});

test('approved product discovers matching prospects and drafts its actual product offer with no enrichment provider or automatic sending',async()=>{
 const {env,close}=database();Object.assign(env,{OPENAI_API_KEY:'fixture',ENABLE_AUTOMATION:'true'});const original=globalThis.fetch,{fetcher,calls}=mockOpenAI();globalThis.fetch=fetcher;
 try{
  const p=await approved(env),scope=await scopeProduct(env,p);
  await run(scope,"UPDATE settings SET data=json_set(data,'$.locationIds',json('[\"country:GB\"]'))");
  await startDiscovery(scope,await settings(scope));for(let step=0;step<13;step++)await tick(scope);
  const lead=await one<any>(scope,'SELECT * FROM leads'),draft=await one<any>(scope,'SELECT * FROM drafts');
  assert.ok(lead);assert.equal(lead.contact_status,'publicly_sourced');assert.equal(draft.quality_hold,'');assert.equal(draft.status,'pending');assert.equal(draft.approved_hash,null);assert.match(draft.body,/flange|pressure/i);
  const writing=calls.find(c=>c.text?.format?.schema?.properties?.remarksApplied&&c.text?.format?.schema?.properties?.body);assert.ok(writing?.instructions.includes(emailStyleInstructions));
  const discovery=calls.find(c=>c.instructions.includes('This is the BUSINESS DISCOVERY pass'));assert.deepEqual(discovery?.tools?.[0]?.user_location,{type:'approximate',country:'GB'});
  assert.equal(JSON.parse(draft.free_offer).type,'product');assert.doesNotMatch(draft.body,/free|30.day|Adobe/i);
  assert.ok(calls.every(c=>c.instructions.includes(input.remarks)));assert.equal((await all(scope,'SELECT * FROM messages')).length,0);assert.equal((await all(env,'SELECT * FROM leads')).length,0);
 }finally{globalThis.fetch=original;close();}
});

test('the same business and email have independent product conversations and budgets',async()=>{
 const {env,close}=database();env.OPENAI_API_KEY='fixture';const original=globalThis.fetch;globalThis.fetch=mockOpenAI().fetcher;
 try{
  const a=await scopeProduct(env,await approved(env,'First product')),b=await scopeProduct(env,await approved(env,'Second product'));
  const la=await readyLead(a),lb=await readyLead(b);assert.notEqual(la.id,lb.id);assert.equal(la.email,lb.email);
  await readyDraft(a,la);assert.equal((await all(b,'SELECT * FROM drafts')).length,0);
  await run(a,"INSERT INTO expenses(id,provider,month,reserved,reference,created_at) VALUES('cap','openai',?,44.9999,'test',?)",month(),now());
  await assert.rejects(openai(a,await settings(a),'x','x','cap',{search:true,stage:'cap',workflow:{jobId:'cap',paidCalls:0}}),BudgetPaused);
  await openai(b,await settings(b),'x','x','b',{search:true,stage:'b',workflow:{jobId:'b',paidCalls:0}});
  assert.ok((await one<any>(b,"SELECT SUM(reserved) n FROM expenses WHERE provider='openai'")).n<2);
  assert.equal((await all(env,'SELECT * FROM drafts')).length,0);
 }finally{globalThis.fetch=original;close();}
});

test('sending exceeds the former daily cap and uses each product sender',async()=>{
 const {env,close}=database();Object.assign(env,{OPENAI_API_KEY:'fixture',ENABLE_SENDING:'true',GOOGLE_CLIENT_ID:'fixture',GOOGLE_CLIENT_SECRET:'fixture',GOOGLE_REFRESH_TOKEN:'fixture'});
 const original=globalThis.fetch;globalThis.fetch=mockOpenAI().fetcher;const raw:string[]=[];
 try{
  await run(env,'INSERT INTO settings VALUES(1,?)',JSON.stringify(testSettings));const pa=await approved(env,'A'),pb=await approved(env,'B');
  await run(env,'UPDATE products SET sender_email=? WHERE id=?','alias@example.org',pb.id);
  const a=await scopeProduct(env,pa),b=await scopeProduct(env,await product(env,pb.id));
  globalThis.fetch=(async(url:any,init?:RequestInit)=>{if(String(url).includes('settings/sendAs'))return Response.json({sendAs:[{sendAsEmail:'data@prepyr.com',verificationStatus:'accepted'},{sendAsEmail:'alias@example.org',verificationStatus:'accepted'}]});return mockGoogle(body=>{raw.push(Buffer.from(body.raw,'base64url').toString());return Response.json({id:'sent-'+raw.length,threadId:'thread-'+raw.length});})(url,init);}) as typeof fetch;
  await run(a,'INSERT INTO daily_usage(day,send_slots,new_slots) VALUES(?,11,11)',day());
  const first=await readyDraft(a,await readyLead(a));await sendApproved(a,await settings(a));assert.equal((await one<any>(a,'SELECT status FROM drafts WHERE id=?',first.id)).status,'sent');
  const held=await readyDraft(a,await readyLead(a,{company:'Another supplier',email:'another@example.org'}));await sendApproved(a,await settings(a));assert.equal((await one<any>(a,'SELECT status FROM drafts WHERE id=?',held.id)).status,'sent');
  await readyDraft(b,await readyLead(b));await sendApproved(b,await settings(b));assert.equal(raw.length,3);assert.match(raw[2],/alias@example.org/);assert.equal((await one<any>(a,'SELECT send_slots FROM daily_usage')).send_slots,13);assert.equal((await one<any>(b,'SELECT send_slots FROM daily_usage')).send_slots,1);
 }finally{globalThis.fetch=original;close();}
});

test('global opt-outs block all product senders and signed product unsubscribe does not affect another business',async()=>{
 const {env,close}=database();env.OPENAI_API_KEY='fixture';const original=globalThis.fetch;globalThis.fetch=mockOpenAI().fetcher;
 try{
  await run(env,'INSERT INTO settings VALUES(1,?)',JSON.stringify(testSettings));
  const a=await scopeProduct(env,await approved(env,'A')),b=await scopeProduct(env,await approved(env,'B')),la=await readyLead(a),lb=await readyLead(b);
  await readyDraft(b,lb);await suppress(a,la,'optout');assert.ok(await one(env,'SELECT email FROM suppressions WHERE email=?',la.email));
  b.ENABLE_SENDING='true';let calls=0;globalThis.fetch=(async()=>{calls++;throw Error('No provider calls permitted');}) as typeof fetch;
  await sendApproved(b,await settings(b));assert.equal(calls,0);assert.match((await one<any>(b,'SELECT error FROM drafts')).error,/opted out/);
  const url=new URL(await unsubscribeUrl(a,la.id));assert.equal((await req(env,url.pathname+url.search)).status,200);url.searchParams.set('product',b.PRODUCT_ID!);assert.equal((await req(env,url.pathname+url.search)).status,400);
 }finally{globalThis.fetch=original;close();}
});

test('product edits revoke target approval and unsent approvals while preserving sent history and owner text',async()=>{
 const {env,close}=database();env.OPENAI_API_KEY='fixture';const original=globalThis.fetch;globalThis.fetch=mockOpenAI().fetcher;
 try{
  const p=await approved(env),scope=await scopeProduct(env,p),lead=await readyLead(scope),d=await readyDraft(scope,lead);
  await run(scope,"INSERT INTO messages(id,lead_id,direction,subject,body,created_at) VALUES('prior',?,'outbound','Saved subject','Saved body',?)",lead.id,now());
  await saveProduct(env,{...input,revision:p.revision,remarks:'New product details'},p.id);
  const next=await product(env,p.id),saved=await one<any>(scope,'SELECT * FROM drafts');assert.equal(next.state,'draft');assert.equal(next.approved_revision,null);assert.equal(saved.body,d.body);assert.equal(saved.approved_hash,null);assert.match(saved.quality_hold,/Product details changed/);assert.equal((await one<any>(scope,'SELECT body FROM messages')).body,'Saved body');
  await assert.rejects(saveProduct(env,{...input,revision:p.revision},p.id),/another window/);
 }finally{globalThis.fetch=original;close();}
});

test('product APIs enforce authentication, scope record IDs and reject executable screenshot input',async()=>{
 const {env,close}=database();try{
  assert.equal((await req(env,'/api/products')).status,401);const cookie=await login(env);
  const created=await req(env,'/api/products',input,cookie);assert.equal(created.status,200);const p=(await created.json() as any).product;
  const scope=await scopeProduct(env,await product(env,p.id));const l=await readyLead(scope);
  assert.equal((await req(env,'/api/prospects/'+l.id,undefined,cookie)).status,404);
  assert.equal((await req(env,'/api/prospects/'+l.id+'?product='+p.id,undefined,cookie)).status,200);
  assert.equal((await req(env,'/api/discover?product='+p.id,{},cookie)).status,400);
  const bad=await req(env,'/api/products',{...input,images:[{name:'bad.svg',data:'data:image/svg+xml;base64,PHN2Zy8+'}]},cookie);assert.equal(bad.status,400);assert.equal((await productList(env)).length,1);
 }finally{close();}
});

test('private candidates do not consume qualified slots while actual research stops at twenty independently per product',async()=>{
 const {env,close}=database();env.OPENAI_API_KEY='fixture';const original=globalThis.fetch;globalThis.fetch=mockOpenAI().fetcher;
 try{
  const a=await scopeProduct(env,await approved(env,'A')),b=await scopeProduct(env,await approved(env,'B'));
  for(let i=0;i<20;i++){const id=await importLead(a,{company:'Business '+i,email:`business${i}@example.org`});assert.ok(id);assert.equal(await claimResearchBusiness(a,id!,20),true);}
  assert.ok(await importLead(a,{company:'Twenty first',email:'twentyfirst@example.org'}));assert.equal(await claimResearchBusiness(a,'unclaimed',20),false);assert.ok(await importLead(b,{company:'Twenty first',email:'twentyfirst@example.org'}));assert.equal(await claimResearchBusiness(b,'new-business',20),true);
 }finally{globalThis.fetch=original;close();}
});

test('missing schema is explicit and never disguised as a healthy saved workspace',async()=>{
 const {env,close}=database();try{await run(env,'DROP TABLE products');assert.equal((await req(env,'/health')).status,503);const cookie=await login(env),r=await req(env,'/api/products',undefined,cookie);assert.equal(r.status,503);assert.equal((await r.json() as any).code,'SCHEMA_REQUIRED');assert.equal(isD1Unavailable(Error('D1_ERROR: no such table: products')),false);}finally{close();}
});

test('a reply belongs only to the product thread that was actually contacted',async()=>{
 const {env,close}=database();env.OPENAI_API_KEY='fixture';const original=globalThis.fetch;globalThis.fetch=mockOpenAI().fetcher;
 try{
  const a=await scopeProduct(env,await approved(env,'A')),b=await scopeProduct(env,await approved(env,'B')),la=await readyLead(a),lb=await readyLead(b);
  await run(a,'UPDATE leads SET thread_id=?,last_sent_at=? WHERE id=?','thread-a',now(),la.id);await run(b,'UPDATE leads SET thread_id=?,last_sent_at=? WHERE id=?','thread-b',now(),lb.id);
  for(const scope of [a,b])Object.assign(scope,{GOOGLE_CLIENT_ID:'fixture',GOOGLE_CLIENT_SECRET:'fixture',GOOGLE_REFRESH_TOKEN:'fixture'});
  globalThis.fetch=(async(url:any)=>{const u=String(url);if(u.includes('oauth2'))return Response.json({access_token:'fixture'});if(u.includes('messages?'))return Response.json({messages:[{id:'reply-a'}]});return Response.json({id:'reply-a',threadId:'thread-a',payload:{mimeType:'text/plain',headers:[{name:'From',value:la.email},{name:'Subject',value:'Interested in product A'}],body:{data:Buffer.from('Can you show product A?').toString('base64url')}}});}) as typeof fetch;
  await syncInbox(a);await syncInbox(b);assert.equal((await all(a,"SELECT * FROM messages WHERE direction='inbound'")).length,1);assert.equal((await all(b,"SELECT * FROM messages WHERE direction='inbound'")).length,0);assert.equal((await one<any>(b,'SELECT last_inbound_at FROM leads')).last_inbound_at,null);
 }finally{globalThis.fetch=original;close();}
});

test('stale approved product contexts cannot spend or send and unstarted research resumes with the new revision',async()=>{
 const {env,close}=database();env.OPENAI_API_KEY='fixture';const original=globalThis.fetch;const ai=mockOpenAI();globalThis.fetch=ai.fetcher;
 try{
  const p=await approved(env),old=await scopeProduct(env,p),lead=await readyLead(old);await scheduleResearch(old);
  await saveProduct(env,{...input,revision:p.revision,remarks:'New target segment'},p.id);
  const count=ai.calls.length;await assert.rejects(openai(old,await settings(old),'x','x','stale',{search:true,stage:'business_research',workflow:{jobId:'stale',paidCalls:0}}),/changed/);await assert.rejects(sendApproved(old,await settings(old)),/changed/);assert.equal(ai.calls.length,count);
  await queueProductAnalysis(env,p.id);for(let i=0;i<3;i++)await advanceProductAnalysis(env,await product(env,p.id));await approveProduct(env,p.id,p.revision+1);
  const current=await scopeProduct(env,await product(env,p.id));await scheduleResearch(current);const jobs=await all<any>(current,"SELECT id,state FROM jobs WHERE lead_id=?",lead.id);assert.ok(jobs.some(j=>j.state==='cancelled'));assert.ok(jobs.some(j=>j.state==='pending'&&j.id.includes(':2:')));
 }finally{globalThis.fetch=original;close();}
});

test('evidence formatting is normalized without accepting paraphrases and failed extraction is repaired once from the saved search',async()=>{
 assert.equal(containsExcerpt('We offer **custom software development** for businesses.','We offer custom software development for businesses.'),true);
 assert.equal(containsExcerpt('We offer software support for businesses.','We offer custom software development for businesses.'),false);
 const {env,close}=database();env.OPENAI_API_KEY='fixture';const original=globalThis.fetch,{fetcher,calls}=mockOpenAI({badEvidence:true});globalThis.fetch=fetcher;
 try{const p=await approved(env),scope=await scopeProduct(env,p);scope.ENABLE_AUTOMATION='true';await startDiscovery(scope,await settings(scope));for(let i=0;i<5;i++)await tick(scope);assert.equal((await all(scope,'SELECT id FROM leads')).length,1);const discovery=calls.filter(c=>c.text?.format?.name==='relay_discover_evidence_repair');assert.equal(discovery.length,1);assert.equal((await all(scope,"SELECT id FROM ai_attempts WHERE stage='discover_search'")).length,1);}finally{globalThis.fetch=original;close();}
});

test('product research stays on its domain and repairs one paraphrased capability quote without repeating search',async()=>{
 const {env,close}=database();env.OPENAI_API_KEY='fixture';const original=globalThis.fetch,ai=mockOpenAI();
 globalThis.fetch=async(url,init)=>{const response=await ai.fetcher(url,init);if(String(url)!=='https://api.openai.com/v1/responses')return response;const request=JSON.parse(String(init?.body));if(request.text?.format.name!=='relay_product_extract')return response;const data:any=await response.json(),content=data.output.at(-1).content[0],profile=JSON.parse(content.text);profile.useCases[0].capabilityEvidence.excerpt='A paraphrase that does not occur in the product evidence';content.text=JSON.stringify(profile);return Response.json(data);};
 try{const p=await approved(env);assert.equal(p.state,'approved');assert.equal(ai.calls.filter(c=>c.tools).length,1);assert.deepEqual(ai.calls[0].tools[0].filters.allowed_domains,['pumps.example.com']);assert.match(ai.calls[0].instructions,/CURRENT TASK BOUNDARY/);assert.equal(ai.calls.filter(c=>c.text?.format.name==='relay_product_profile_evidence_repair').length,1);}finally{globalThis.fetch=original;close();}
});


test('product email preview and Gmail MIME use the same saved product link',async()=>{
 const {env,close}=database();Object.assign(env,{OPENAI_API_KEY:'fixture',ENABLE_SENDING:'true',GOOGLE_CLIENT_ID:'fixture',GOOGLE_CLIENT_SECRET:'fixture',GOOGLE_REFRESH_TOKEN:'fixture'});const original=globalThis.fetch;globalThis.fetch=mockOpenAI().fetcher;
 try{
  const p=await approved(env),scope=await scopeProduct(env,p);await run(scope,'UPDATE settings SET data=?',JSON.stringify(testSettings));
  const lead=await readyLead(scope),draft=await readyDraft(scope,lead);draft.body='Your catalogue lists DIN flanges and your quotes need pressure ratings. FlangeFlow could help collect both.';
  const {approvalHash}=await import('../src/policy');await run(scope,`UPDATE drafts SET body=?,artifact='',approved_hash=? WHERE id=?`,draft.body,await approvalHash({...draft,artifact:''},lead,testSettings,scope.SENDER_EMAIL!),draft.id);
  const cookie=await login(env),response=await req(env,`/api/drafts/${draft.id}/preview?product=${p.id}`,undefined,cookie);assert.equal(response.status,200);const preview=await response.json() as any;
  assert.match(preview.html,/<a href="https:\/\/pumps.example.com\/"[^>]*>FlangeFlow<\/a>/);
  let sent='';globalThis.fetch=mockGoogle(body=>{sent=Buffer.from(body.raw,'base64url').toString();return Response.json({id:'fixture-sent',threadId:'fixture-thread'});});
  await sendApproved(scope,testSettings,draft.id);assert.ok(sent.replace(/\r\n/g,'').includes(Buffer.from(preview.html).toString('base64')));
 }finally{globalThis.fetch=original;close();}
});
