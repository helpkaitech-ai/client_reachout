import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
import worker from '../src/index';
import {database,testSettings,readyLead,readyDraft} from './helpers';
import {all,one,run,settings,now} from '../src/db';
import {saveProduct,product,productDetail,scopeProduct,queueProductAnalysis,advanceProductAnalysis,approveProduct,controlProductProspecting} from '../src/products';
import {openai} from '../src/providers';
import {nextProductCampaign} from '../src/locations';
import {startDiscovery,importLead} from '../src/discovery';
import {scheduleResearch,processAvailableJobs} from '../src/engine';
import {mockOpenAI} from './openai-fixture';

const input={name:'Product A',website:'https://pumps.example.com',description:'Specification intake product',sender_email:'data@prepyr.com'};
const ctx={waitUntil:()=>{}} as unknown as ExecutionContext;
async function req(env:any,path:string,payload?:any,cookie=''){return worker.fetch(new Request(env.APP_URL+path,{method:payload===undefined?'GET':'POST',headers:{Origin:env.APP_URL,'X-Requested-With':'Prepyr',Cookie:cookie},...(payload===undefined?{}:{body:JSON.stringify(payload)})}),env,ctx);}
async function login(env:any){return (await req(env,'/api/login',{password:env.ADMIN_PASSWORD})).headers.get('set-cookie')!.split(';')[0];}
async function pair(env:any){await run(env,'INSERT INTO settings VALUES(1,?)',JSON.stringify({...testSettings,prospectingPaused:true,discoveryPaused:true}));return [await saveProduct(env,input),await saveProduct(env,{...input,name:'Product B',description:'Other product'})];}
async function manualApprove(env:any,id:string){await run(env,"UPDATE products SET state='approved',approved_revision=revision WHERE id=?",id);return scopeProduct(env,await product(env,id));}

test('sender, locations, customer targeting, offers, portfolio, budgets and daily/search limits persist only in the selected workspace',async()=>{
 const {env,close}=database();try{
  const [a,b]=await pair(env),cookie=await login(env),root=JSON.stringify(await settings(env));
  assert.equal((await req(env,'/api/settings/sender?product='+a.id,{senderName:'Agency sender',businessAddress:'Product A address',senderEmail:'alias@example.org'},cookie)).status,200);
  assert.equal((await req(env,'/api/settings/locations?product='+a.id,{locationIds:['city:mumbai']},cookie)).status,200);
  const scope=await scopeProduct(env,await product(env,a.id)),s=await settings(scope),next={...s,offerContext:'Editing workflow product; no free trial',portfolio:'Portfolio A; $19 per month',customerTypes:['b2b','agencies'],customerDescription:'Small video editing agencies',customerComments:'Prefer independent studios; exclude wedding venues',dailyLeadLimit:3,dailyResearchLimit:4,dailyNewLimit:2,dailyTotalLimit:3,openaiBudget:7,discoveryResults:2,discoveryIntervalDays:9,sendStartHour:10,sendEndHour:16,followupDays:[5,12],sendWeekends:false,providerPolicyConfirmed:false};
  const response=await req(env,'/api/settings/preferences?product='+a.id,next,cookie);assert.equal(response.status,200);assert.equal((await response.json() as any).profileChanged,true);
  const saved=await settings(await scopeProduct(env,await product(env,a.id))),other=await settings(await scopeProduct(env,b));
  for(const key of Object.keys(next) as (keyof typeof next)[])if(!['campaigns','researchAutomation','outreachPaused'].includes(key))assert.deepEqual(saved[key],next[key],key);
  assert.equal(saved.senderName,'Agency sender');assert.equal(saved.businessAddress,'Product A address');assert.equal((await product(env,a.id)).sender_email,'alias@example.org');
  assert.equal(other.senderName,testSettings.senderName);assert.equal(other.offerContext,b.description);assert.equal(other.portfolio,'');assert.equal(other.openaiBudget,50);assert.equal(other.discoveryIntervalDays,6);assert.deepEqual(other.customerTypes,[]);assert.deepEqual(other.locationIds,['worldwide']);assert.equal(JSON.stringify(await settings(env)),root);
  assert.equal((await all(env,'SELECT * FROM ai_attempts')).length,0);assert.equal((await all(scope,'SELECT * FROM ai_attempts')).length,0);
  const da=await(await req(env,'/api/dashboard?summary=1&product='+a.id,undefined,cookie)).json() as any,db=await(await req(env,'/api/dashboard?summary=1&product='+b.id,undefined,cookie)).json() as any;
  for(const key of ['gmail','openai','telegram','notificationEmail'])assert.deepEqual(da.connections[key],db.connections[key]);assert.equal(da.connections.sender,'alias@example.org');assert.equal(db.connections.sender,'data@prepyr.com');
 }finally{close();}
});

test('targeting changes invalidate stale approvals and preserve sent history, while changing numerical limits does not invalidate targeting',async()=>{
 const {env,close}=database();env.OPENAI_API_KEY='mock';try{
  const [a,b]=await pair(env),scope=await manualApprove(env,a.id),cookie=await login(env),lead=await readyLead(scope),draft=await readyDraft(scope,lead);
  let response=await req(env,'/api/settings/preferences?product='+a.id,{...await settings(scope),openaiBudget:10,dailyResearchLimit:5,discoveryIntervalDays:8},cookie);assert.equal(response.status,200);assert.equal((await response.json() as any).profileChanged,false);assert.equal((await product(env,a.id)).state,'approved');
  const sentLead=await readyLead(scope,{company:'Sent',website:'https://sent.example.org',email:'sent@example.org'}),sent=await readyDraft(scope,sentLead);await run(scope,"UPDATE drafts SET status='sent' WHERE id=?",sent.id);
  response=await req(env,'/api/settings/preferences?product='+a.id,{...await settings(scope),customerTypes:['agencies'],customerDescription:'Video production agencies'},cookie);assert.equal(response.status,200);
  const p=await product(env,a.id);assert.equal(p.state,'draft');assert.equal(p.revision,a.revision+1);assert.equal(p.approved_revision,null);assert.equal((await settings(scope)).prospectingPaused,true);
  const held=await one<any>(scope,'SELECT * FROM drafts WHERE id=?',draft.id);assert.equal(held.body,draft.body);assert.equal(held.status,'pending');assert.equal(held.approved_hash,null);assert.match(held.quality_hold,/targeting/);assert.equal((await one<any>(scope,'SELECT status FROM drafts WHERE id=?',sent.id)).status,'sent');
  await assert.rejects(openai(scope,testSettings,'x','x','stale',{search:true,stage:'business_research',workflow:{jobId:'stale',paidCalls:0}}),/changed/);assert.equal((await product(env,b.id)).revision,b.revision);
 }finally{close();}
});

test('customer inputs on product creation are validated, exposed for editing and preserved with owner offers through profile approval',async()=>{
 const {env,close}=database(),original=globalThis.fetch,ai=mockOpenAI();env.OPENAI_API_KEY='mock';globalThis.fetch=ai.fetcher;
 try{
  await assert.rejects(saveProduct(env,{...input,customerTypes:['invalid']}),/customer types/);assert.equal((await all(env,'SELECT * FROM products')).length,0);
  const p=await saveProduct(env,{...input,customerTypes:['b2b','startups'],customerDescription:'Pump supply startups',customerComments:'Prioritize specification workflows'}),scope=await scopeProduct(env,p);
  await run(scope,"UPDATE settings SET data=json_set(data,'$.offerContext',?,'$.portfolio',?,'$.researchAutomation',json('false'))",'Owner product offer; no free trials','Portfolio and pricing: $29/month');
  await queueProductAnalysis(env,p.id);await advanceProductAnalysis(env,await product(env,p.id));await advanceProductAnalysis(env,await product(env,p.id));await approveProduct(env,p.id,p.revision);
  const detail=await productDetail(env,p.id);assert.deepEqual(detail.product.customerTypes,['b2b','startups']);assert.equal(detail.product.customerDescription,'Pump supply startups');assert.equal(detail.settings.offerContext,'Owner product offer; no free trials');assert.equal(detail.settings.portfolio,'Portfolio and pricing: $29/month');assert.equal(detail.settings.researchAutomation,false);
  assert.ok(ai.calls.every(c=>c.instructions.includes('Pump supply startups')&&c.instructions.includes('Prioritize specification workflows')&&c.instructions.includes('$29/month')));
  const fresh=await scopeProduct(env,await product(env,p.id));await controlProductProspecting(env,p.id,false);await readyLead(fresh);await scheduleResearch(fresh);for(let i=0;i<9;i++)await processAvailableJobs(fresh,{...await settings(fresh),researchAutomation:true});
  assert.ok(await one(fresh,'SELECT id FROM drafts'));assert.ok(ai.calls.filter(c=>c.text?.format.name==='relay_draft_generate').every(c=>c.instructions.includes('Pump supply startups')&&c.instructions.includes('$29/month')));
 }finally{globalThis.fetch=original;close();}
});

test('product geography overrides retain OpenAI-derived topics, and each workspace obeys its own search interval',async()=>{
 const {env,close}=database();env.OPENAI_API_KEY='mock';try{
  const [a,b]=await pair(env),sa=await manualApprove(env,a.id),sb=await manualApprove(env,b.id),campaign={query:'AI-selected editing agencies',location:'London, UK',country:'GB',timezone:'Europe/London',enabled:true};
  for(const [scope,interval]of [[sa,9],[sb,2]] as const){await run(scope,'UPDATE settings SET data=?',JSON.stringify({...testSettings,campaigns:[campaign],locationIds:['city:mumbai'],discoveryIntervalDays:interval,discoveryPaused:false,prospectingPaused:false}));const date=new Date(Date.now()-4*86400000).toISOString();await run(scope,"INSERT INTO discovery_batches(id,job_id,campaign,state,created_at,updated_at) VALUES('past','past',?,'complete',?,?)",JSON.stringify(campaign),date,date);}
  const selected=nextProductCampaign(await settings(sa),[]);assert.equal(selected.country,'IN');assert.equal(selected.location,'Mumbai, India');assert.equal(selected.query,campaign.query);
  assert.equal((await startDiscovery(sa,await settings(sa))).state,'cooldown');assert.equal((await startDiscovery(sb,await settings(sb))).state,'queued');assert.equal((await all(sa,'SELECT * FROM ai_attempts')).length,0);assert.equal((await all(sb,'SELECT * FROM ai_attempts')).length,0);
 }finally{close();}
});

test('per-product new prospect limits are enforced independently and invalid settings never overwrite stored preferences',async()=>{
 const {env,close}=database();try{
  const [a,b]=await pair(env),sa=await manualApprove(env,a.id),sb=await manualApprove(env,b.id),cookie=await login(env);
  assert.equal((await req(env,'/api/settings/preferences?product='+a.id,{...await settings(sa),dailyLeadLimit:1},cookie)).status,200);
  await importLead(sa,{company:'One',website:'https://one.example.org'});await assert.rejects(importLead(sa,{company:'Two',website:'https://two.example.org'}),/1 new leads/);assert.ok(await importLead(sb,{company:'Two',website:'https://two.example.org'}));
  const before=JSON.stringify(await settings(sa));for(const bad of [{dailyLeadLimit:21},{dailyTotalLimit:13},{openaiBudget:51},{customerTypes:['b2b','b2b']},{customerComments:'x'.repeat(8001)}])assert.equal((await req(env,'/api/settings/preferences?product='+a.id,{...await settings(sa),...bad},cookie)).status,400);
  assert.equal((await req(env,'/api/settings/sender?product='+a.id,{senderName:'x',businessAddress:'x',senderEmail:'invalid'},cookie)).status,400);assert.equal(JSON.stringify(await settings(sa)),before);
 }finally{close();}
});

test('product discovery rejects private or sensitive individual targeting and can retain public professional contacts',async()=>{
 for(const [scopeType,sensitive,expected]of [['private_consumer',false,0],['organization',true,0],['public_professional',false,1]] as const){
  const {env,close}=database(),original=globalThis.fetch,ai=mockOpenAI();env.OPENAI_API_KEY='mock';
  globalThis.fetch=(async(url:any,init:any)=>{const response=await ai.fetcher(url,init),body=JSON.parse(init.body);if(body.text?.format.name==='relay_discover_extract'){const data:any=await response.json(),out=JSON.parse(data.output.at(-1).content[0].text);for(const c of out.candidates){c.contactScope=scopeType;c.sensitivePersonalTarget=sensitive;c.contact_name='Alex';}data.output.at(-1).content[0].text=JSON.stringify(out);return Response.json(data);}return response;}) as typeof fetch;
  try{const p=await saveProduct(env,input),scope=await manualApprove(env,p.id);await run(scope,'UPDATE settings SET data=?',JSON.stringify({...testSettings,prospectingPaused:false,discoveryPaused:false,campaigns:[{query:'Pump specification professionals',location:'London, UK',country:'GB',timezone:'Europe/London',enabled:true}]}));await startDiscovery(scope,await settings(scope));for(let i=0;i<3;i++)await processAvailableJobs(scope);assert.equal((await all(scope,'SELECT * FROM leads')).length,expected);if(expected)assert.equal((await one<any>(scope,'SELECT contact_name FROM leads')).contact_name,'Alex');assert.ok(ai.calls.every(c=>c.instructions.includes('sensitive personal traits')));}finally{globalThis.fetch=original;close();}
 }
});

test('actual Settings UI keeps the selected tab while switching products and saves customer and offer inputs without leaking to another product',async()=>{
 const {env,close}=database(),base=env.APP_URL!,dom=new JSDOM(fs.readFileSync('public/index.html','utf8'),{url:base,runScripts:'outside-only'}),doc=dom.window.document,paths:string[]=[];
 const until=async(fn:()=>boolean)=>{for(let i=0;i<150;i++){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('UI update failed: '+doc.querySelector('#toast')?.textContent);};
 const click=(selector:string)=>(doc.querySelector(selector) as HTMLElement).click();
 try{
  const [a,b]=await pair(env),cookie=await login(env);(dom.window as any).fetch=(path:string,init:any)=>{paths.push(path);return worker.fetch(new Request(base+path,{...init,headers:{...init.headers,Origin:base,Cookie:cookie}}),env,ctx);};
  dom.window.eval(fs.readFileSync('public/app.js','utf8'));await until(()=>!!doc.querySelector('[data-discovery-control]'));click('[data-view="settings"]');await until(()=>!!doc.querySelector('#settings-form'));
  let select=doc.querySelector('#product-switch') as unknown as HTMLSelectElement;select.value=a.id;select.dispatchEvent(new dom.window.Event('change',{bubbles:true}));await until(()=>doc.querySelector('#breadcrumb')?.textContent==='Product A / Settings');
  for(const name of ['offerContext','portfolio','customerDescription','customerComments','senderEmail'])assert.ok(doc.querySelector('[name="'+name+'"]'));assert.ok(doc.querySelector('#locations-form'));
  const values={offerContext:'Video editing product for agencies',portfolio:'Portfolio A; $19/month',customerDescription:'Small editing studios',customerComments:'Exclude wedding venues'};
  for(const [key,value]of Object.entries(values))(doc.querySelector('#settings-form [name="'+key+'"]') as HTMLTextAreaElement).value=value;
  (doc.querySelector('#settings-form [name="customerTypes"][value="agencies"]') as HTMLInputElement).checked=true;
  (doc.querySelector('#settings-form') as HTMLFormElement).dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));await until(()=>!!doc.querySelector('#toast')?.textContent?.includes('analyze and approve'));
  const stored=await settings(await scopeProduct(env,await product(env,a.id)));assert.deepEqual(stored.customerTypes,['agencies']);assert.equal(stored.offerContext,values.offerContext);
  select=doc.querySelector('#product-switch') as unknown as HTMLSelectElement;select.value=b.id;select.dispatchEvent(new dom.window.Event('change',{bubbles:true}));await until(()=>doc.querySelector('#breadcrumb')?.textContent==='Product B / Settings');assert.equal((doc.querySelector('[name="offerContext"]') as HTMLTextAreaElement).value,b.description);assert.equal((doc.querySelector('[name="portfolio"]') as HTMLTextAreaElement).value,'');assert.equal(doc.querySelector('a[download]')!.getAttribute('href'),'/api/export?product='+b.id);
  click('[data-view="dashboard"]');await until(()=>doc.querySelector('#breadcrumb')?.textContent==='Product B / Dashboard');select=doc.querySelector('#product-switch') as unknown as HTMLSelectElement;select.value=a.id;select.dispatchEvent(new dom.window.Event('change',{bubbles:true}));await until(()=>doc.querySelector('#breadcrumb')?.textContent==='Product A / Dashboard');assert.ok(paths.some(p=>p.includes('/api/settings/preferences?product='+a.id)));assert.equal((await all(env,'SELECT * FROM ai_attempts')).length,0);
  const unsafe='Product A <img src=x onerror=alert(1)>';await run(env,'UPDATE products SET name=? WHERE id=?',unsafe,a.id);click('[data-view="settings"]');click('#refresh');await until(()=>doc.querySelector('#breadcrumb')?.textContent===unsafe+' / Settings');assert.equal(doc.querySelector('#content img'),null);assert.ok(doc.querySelector('#content')!.textContent!.includes(unsafe));
 }finally{dom.window.close();close();}
});

test('a delayed response from another workspace cannot replace the selected product settings',async()=>{
 const {env,close}=database(),base=env.APP_URL!,dom=new JSDOM(fs.readFileSync('public/index.html','utf8'),{url:base,runScripts:'outside-only'}),doc=dom.window.document;
 let release:()=>void=()=>{},delayed=false;const gate=new Promise<void>(r=>{release=r;});
 const until=async(fn:()=>boolean)=>{for(let i=0;i<150;i++){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('Workspace race test timed out');};
 try{
  const [a,b]=await pair(env),cookie=await login(env);
  (dom.window as any).fetch=async(path:string,init:any)=>{if(path.includes('/api/dashboard?')&&path.includes('product='+a.id)){delayed=true;await gate;}return worker.fetch(new Request(base+path,{...init,headers:{...init.headers,Origin:base,Cookie:cookie}}),env,ctx);};
  dom.window.eval(fs.readFileSync('public/app.js','utf8'));await until(()=>!!doc.querySelector('[data-discovery-control]'));(doc.querySelector('[data-view="settings"]') as HTMLElement).click();await until(()=>!!doc.querySelector('#settings-form'));
  const select=doc.querySelector('#product-switch') as unknown as HTMLSelectElement;select.value=a.id;select.dispatchEvent(new dom.window.Event('change',{bubbles:true}));await until(()=>delayed);assert.equal(doc.querySelector('#settings-form'),null);
  select.value=b.id;select.dispatchEvent(new dom.window.Event('change',{bubbles:true}));await until(()=>doc.querySelector('#breadcrumb')?.textContent==='Product B / Settings');release();await new Promise(r=>setTimeout(r,60));assert.equal(doc.querySelector('#breadcrumb')!.textContent,'Product B / Settings');assert.equal((doc.querySelector('[name="offerContext"]') as HTMLTextAreaElement).value,b.description);
 }finally{release();dom.window.close();close();}
});

test('Find prospects with changed product locations requests profile review without queuing a search',async()=>{
 const {env,close}=database(),base=env.APP_URL!,dom=new JSDOM(fs.readFileSync('public/index.html','utf8'),{url:base,runScripts:'outside-only'}),doc=dom.window.document,paths:string[]=[];env.OPENAI_API_KEY='mock';
 const until=async(fn:()=>boolean)=>{for(let i=0;i<150;i++){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('Location change UI timed out');};
 try{
  const [a]=await pair(env);await manualApprove(env,a.id);await controlProductProspecting(env,a.id,false);const cookie=await login(env);
  (dom.window as any).fetch=(path:string,init:any)=>{paths.push(path);return worker.fetch(new Request(base+path,{...init,headers:{...init.headers,Origin:base,Cookie:cookie}}),env,ctx);};
  dom.window.eval(fs.readFileSync('public/app.js','utf8'));await until(()=>!!doc.querySelector('[data-discovery-control]'));const select=doc.querySelector('#product-switch') as unknown as HTMLSelectElement;select.value=a.id;select.dispatchEvent(new dom.window.Event('change',{bubbles:true}));await until(()=>doc.querySelector('#breadcrumb')?.textContent==='Product A / Prospects');
  const city=doc.querySelector('[name="locationIds"][value="city:mumbai"]') as HTMLInputElement;city.checked=true;city.dispatchEvent(new dom.window.Event('change',{bubbles:true}));(doc.querySelector('[data-action="discover"]') as HTMLElement).click();await until(()=>!!doc.querySelector('#toast')?.textContent?.includes('analyze and approve'));
  assert.equal(paths.some(p=>/^\/api\/discover\?/.test(p)),false);const scope=await scopeProduct(env,await product(env,a.id));assert.equal((await settings(scope)).prospectingPaused,true);assert.equal((await all(scope,'SELECT * FROM discovery_batches')).length,0);assert.equal((await all(scope,'SELECT * FROM ai_attempts')).length,0);
 }finally{dom.window.close();close();}
});
