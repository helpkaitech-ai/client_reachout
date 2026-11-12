import {startDiscovery} from '../src/discovery';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {database,readyLead,testSettings} from './helpers';
import {mockOpenAI,businessReport,contactExcerpt,sourceUrls} from './openai-fixture';
import {all,one,run,settings,now,enqueue} from '../src/db';
import {saveProduct,product,scopeProduct,queueProductAnalysis,advanceProductAnalysis,approveProduct,productList} from '../src/products';
import {processAvailableJobs,scheduleResearch,tickWorkspaces} from '../src/engine';
import {providerBlock,clearProviderBlock} from '../src/provider-control';
import {openai} from '../src/providers';
import {researchContact,reconcileResearchContact,supportedContact,solutionEvidence,designSolution} from '../src/intelligence';
import {prospectPage} from '../src/prospects';
import worker from '../src/index';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';

const input={name:'Product A',website:'https://pumps.example.com',description:'Pump quotation specification product',sender_email:'data@prepyr.com'};
async function rootSettings(env:any,extra:any={}){await run(env,'INSERT INTO settings(id,data) VALUES(1,?)',JSON.stringify({...testSettings,...extra}));}
async function cycleContact(env:any,lead:any,jobId:string){for(let i=0;i<8;i++){try{return await researchContact(env,testSettings,lead,{jobId,paidCalls:0});}catch(e){if((e as Error).constructor.name!=='StageYield')throw e;}}throw Error('Contact workflow did not finish');}
const research={report:businessReport,sources:sourceUrls.map(url=>({url,title:'Source'})),gatheredAt:now()};

test('Relay active permits independent product setup and explicitly requested searches',async()=>{
 const {env,close}=database(),original=globalThis.fetch,ai=mockOpenAI();Object.assign(env,{OPENAI_API_KEY:'mock',ENABLE_AUTOMATION:'true'});globalThis.fetch=ai.fetcher;
 try{
  await rootSettings(env,{prospectingPaused:true,discoveryPaused:true});const legacy=await readyLead(env);await scheduleResearch(env);
  const a=await saveProduct(env,input),b=await saveProduct(env,{...input,name:'Product B'});
  await queueProductAnalysis(env,a.id);await advanceProductAnalysis(env,await product(env,a.id));await advanceProductAnalysis(env,await product(env,a.id));
  await approveProduct(env,a.id,a.revision);const scope=await scopeProduct(env,await product(env,a.id));
  assert.equal((await settings(scope)).prospectingPaused,undefined);assert.equal((await settings(scope)).discoveryPaused,undefined);
  const before=ai.calls.length;await tickWorkspaces(env);assert.equal(ai.calls.length,before);
  await startDiscovery(scope,await settings(scope));for(let i=0;i<14;i++)await tickWorkspaces(env);
  assert.ok(await one(scope,'SELECT id FROM drafts'));assert.equal((await settings(env)).prospectingPaused,undefined);
  assert.equal((await all(env,'SELECT * FROM ai_attempts')).length,0);assert.equal((await all(env,'SELECT * FROM drafts')).length,0);
  assert.equal((await one<any>(env,'SELECT state FROM jobs WHERE lead_id=?',legacy.id)).state,'pending');
  assert.equal((await settings(await scopeProduct(env,b))).prospectingPaused,undefined);
  const list=await productList(env);assert.equal(list.find(p=>p.id===a.id)!.prospecting_paused,undefined);assert.equal(list.find(p=>p.id===b.id)!.prospecting_paused,undefined);
  assert.equal((await all(scope,'SELECT * FROM messages')).length,0);
 }finally{globalThis.fetch=original;close();}
});

test('one credit rejection stops the shared key across workspaces and does not consume unspent daily research slots',async()=>{
 const {env,close}=database(),original=globalThis.fetch;let calls=0;env.OPENAI_API_KEY='mock';
 globalThis.fetch=(async()=>{calls++;return Response.json({error:{code:'credit_balance_exhausted'}},{status:429});}) as typeof fetch;
 try{
  await rootSettings(env);await readyLead(env);await readyLead(env,{company:'Other pumps',website:'https://other.example.com',email:'other@other.example.com'});await scheduleResearch(env);
  await processAvailableJobs(env);for(let i=0;i<3;i++)await processAvailableJobs(env);
  assert.equal(calls,1);assert.ok(await providerBlock(env));assert.equal((await all(env,'SELECT * FROM research_claims')).length,0);
  assert.equal((await all(env,"SELECT * FROM jobs WHERE state='pending'")).length,1);assert.equal((await one<any>(env,'SELECT actual FROM expenses')).actual,0);
  const p=await saveProduct(env,input),scope=await scopeProduct(env,p);await assert.rejects(queueProductAnalysis(env,p.id),/credits need attention/);
  assert.equal(calls,1);assert.equal((await product(env,p.id)).state,'draft');
  await assert.rejects(clearProviderBlock(env,{}),/Confirm/);await clearProviderBlock(env,{billingUpdated:true});assert.equal(await providerBlock(env),null);
  assert.equal((await settings(scope)).prospectingPaused,undefined);assert.equal((await all(env,"SELECT * FROM jobs WHERE state='paused_provider'")).length,1);
 }finally{globalThis.fetch=original;close();}
});

test('paid-plan cycles advance up to three checkpoints without relaxing daily allowances or repeating completed searches',async()=>{
 const {env,close}=database(),original=globalThis.fetch,ai=mockOpenAI();Object.assign(env,{OPENAI_API_KEY:'mock',ENABLE_AUTOMATION:'true',AI_STAGES_PER_CYCLE:'3'});globalThis.fetch=ai.fetcher;
 try{await rootSettings(env,{discoveryPaused:true});const lead=await readyLead(env);await enqueue(env,'research',lead.id,{manual:true});await tickWorkspaces(env);assert.equal(ai.calls.length,3);await tickWorkspaces(env);assert.equal(ai.calls.length,6);assert.equal((await all(env,'SELECT * FROM drafts')).length,1);assert.equal((await all(env,"SELECT * FROM ai_attempts WHERE stage='contact_search'")).length,1);assert.equal((await all(env,'SELECT * FROM research_claims')).length,1);}finally{globalThis.fetch=original;close();}
});

test('a credit failure after successful research retains the daily slot and saved paid stage',async()=>{
 const {env,close}=database(),original=globalThis.fetch,ai=mockOpenAI();let calls=0;env.OPENAI_API_KEY='mock';
 globalThis.fetch=(async(url:any,init:any)=>{calls++;return calls===1?ai.fetcher(url,init):Response.json({error:{code:'credit_balance_exhausted'}},{status:429});}) as typeof fetch;
 try{await rootSettings(env);await readyLead(env);await scheduleResearch(env);await processAvailableJobs(env);await processAvailableJobs(env);assert.equal(calls,2);assert.equal((await all(env,'SELECT * FROM research_claims')).length,1);assert.equal((await all(env,"SELECT * FROM ai_attempts WHERE state='complete'")).length,1);}finally{globalThis.fetch=original;close();}
});

test('unsupported email-shaped results trigger one broader search and use formatting-normalized exact evidence',async()=>{
 const {env,close}=database(),original=globalThis.fetch,ai=mockOpenAI();env.OPENAI_API_KEY='mock';
 globalThis.fetch=(async(url:any,init:any)=>{const body=JSON.parse(init.body),response=await ai.fetcher(url,init);if(body.text?.format.name==='relay_contact_extract'){const d:any=await response.json(),out=JSON.parse(d.output.at(-1).content[0].text);out.identityConfirmed=false;d.output.at(-1).content[0].text=JSON.stringify(out);return Response.json(d);}return response;}) as typeof fetch;
 try{
  const lead=await readyLead(env,{email:null});await enqueue(env,'research',lead.id,{},'contact-test');const record=await cycleContact(env,lead,'contact-test');
  assert.equal(record.status,'publicly_sourced');assert.equal((await one<any>(env,'SELECT email FROM leads')).email,'buyer@pumps.example.com');
  assert.equal((await all(env,"SELECT * FROM ai_attempts WHERE stage='contact_expand_search'")).length,1);
  assert.equal(supportedContact({email:'buyer@pumps.example.com',sourceUrl:sourceUrls[1],excerpt:contactExcerpt,identityConfirmed:true},'For pump enquiries email **buyer@pumps.example.com**',research.sources),true);
  assert.equal(supportedContact({email:'buyer@pumps.example.com',sourceUrl:'https://fake.example.com',excerpt:contactExcerpt,identityConfirmed:true},contactExcerpt,research.sources),false);
 }finally{globalThis.fetch=original;close();}
});

test('later business research reconciles a missing sourced email once without another web search',async()=>{
 const {env,close}=database(),original=globalThis.fetch,ai=mockOpenAI();env.OPENAI_API_KEY='mock';globalThis.fetch=ai.fetcher;
 try{const lead=await readyLead(env,{email:null});await enqueue(env,'research',lead.id,{},'reconcile');await reconcileResearchContact(env,testSettings,lead,research,{jobId:'reconcile',paidCalls:0});await reconcileResearchContact(env,testSettings,lead,research,{jobId:'reconcile',paidCalls:0});assert.equal(ai.calls.length,1);assert.equal(ai.calls[0].tools,undefined);assert.equal((await one<any>(env,'SELECT email FROM leads')).email,'buyer@pumps.example.com');}finally{globalThis.fetch=original;close();}
});

test('material-conflict intelligence replaces blanket contradiction blocking while unsupported evidence still holds',async()=>{
 const {env,close}=database(),original=globalThis.fetch,ai=mockOpenAI();env.OPENAI_API_KEY='mock';
 globalThis.fetch=(async(url:any,init:any)=>{const r=await ai.fetcher(url,init),d:any=await r.json();const body=JSON.parse(init.body);if(body.text?.format.schema.properties.materialConflict){const result=JSON.parse(d.output.at(-1).content[0].text);result.contradictions=['No material contradiction was found'];d.output.at(-1).content[0].text=JSON.stringify(result);}return Response.json(d);}) as typeof fetch;
 try{const lead=await readyLead(env);await enqueue(env,'research',lead.id,{},'evidence');const dossier=await designSolution(env,testSettings,lead,research,{jobId:'evidence',paidCalls:0});assert.equal(dossier.qualityHold,'');assert.equal(ai.calls.length,1);assert.match(solutionEvidence({...dossier,materialConflict:true,materialConflictReason:'Wrong business'},research).qualityHold,/Wrong business/);assert.match(solutionEvidence({...dossier,facts:dossier.facts.map((f:any)=>({...f,evidenceType:'snippet'}))},research).qualityHold,/opened pages/);assert.match(solutionEvidence({...dossier,facts:dossier.facts.map((f:any)=>({...f,excerpt:'Invented unsupported detail'}))},research).qualityHold,/opened pages/);}finally{globalThis.fetch=original;close();}
});

test('stopped unfinished candidates stay out of prospects while recorded task errors remain available',async()=>{
 const {env,close}=database();try{const lead=await readyLead(env,{email:null});await enqueue(env,'research',lead.id,{},'stopped');await run(env,"UPDATE leads SET research_stage='contact_search' WHERE id=?",lead.id);await run(env,"UPDATE jobs SET state='paused_provider',error='OpenAI returned HTTP 429 (credit_balance_exhausted)' WHERE id='stopped'");const result=await prospectPage(env,new URL('https://outreach.example.com/api/prospects'));assert.equal(result.total,0);const job=await one<any>(env,"SELECT * FROM jobs WHERE id='stopped'");assert.equal(job.state,'paused_provider');assert.match(job.error,/credit_balance_exhausted/);}finally{close();}
});

test('removed controls and billing reset remain authenticated; legacy pause flags are discarded',async()=>{
 const {env,close}=database(),origin=env.APP_URL!,ctx={waitUntil:()=>{}} as unknown as ExecutionContext;
 const req=(path:string,data:any,cookie='')=>worker.fetch(new Request(origin+path,{method:'POST',headers:{Origin:origin,'X-Requested-With':'Prepyr',Cookie:cookie},body:JSON.stringify(data)}),env,ctx);
 try{await rootSettings(env,{prospectingPaused:true});const p=await saveProduct(env,input);assert.equal((await req('/api/products/'+p.id+'/prospecting',{paused:false})).status,401);assert.equal((await req('/api/openai/control',{billingUpdated:true})).status,401);const login=await req('/api/login',{password:env.ADMIN_PASSWORD}),cookie=login.headers.get('set-cookie')!.split(';')[0];assert.equal((await req('/api/settings/preferences',{...testSettings,prospectingPaused:false},cookie)).status,200);assert.equal((await settings(env)).prospectingPaused,undefined);assert.equal((await req('/api/products/'+p.id+'/prospecting',{paused:false},cookie)).status,410);assert.equal((await req('/api/products/'+p.id+'/prospecting',{paused:true},cookie)).status,410);assert.equal((await settings(env)).prospectingPaused,undefined);}finally{close();}
});

test('actual UI saves products ready for on-demand searches and retains independent workspaces',async()=>{
 const {env,close}=database(),base=env.APP_URL!,ctx={waitUntil:()=>{}} as unknown as ExecutionContext;
 const dom=new JSDOM(fs.readFileSync('public/index.html','utf8'),{url:base,runScripts:'outside-only'}),doc=dom.window.document;
 (dom.window.HTMLDialogElement.prototype as any).showModal=function(){this.open=true;};(dom.window.HTMLDialogElement.prototype as any).close=function(){this.open=false;};
 async function until(predicate:()=>boolean){for(let i=0;i<150;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}throw Error('UI did not update: '+doc.querySelector('#toast')?.textContent);}
 async function click(selector:string){const button=doc.querySelector(selector) as HTMLElement;assert.ok(button,selector);button.click();}
 try{
  await rootSettings(env,{prospectingPaused:true,discoveryPaused:true});const a=await saveProduct(env,input),b=await saveProduct(env,{...input,name:'Product B'});await run(env,"UPDATE products SET state='approved',approved_revision=revision");
  const lead=await readyLead(env,{email:null});await enqueue(env,'research',lead.id,{},'blocked-ui');await run(env,"UPDATE leads SET research_stage='contact_search' WHERE id=?",lead.id);await run(env,"UPDATE jobs SET state='paused_provider',error='OpenAI returned HTTP 429 (credit_balance_exhausted)' WHERE id='blocked-ui'");
  const login=await worker.fetch(new Request(base+'/api/login',{method:'POST',headers:{Origin:base,'X-Requested-With':'Prepyr'},body:JSON.stringify({password:env.ADMIN_PASSWORD})}),env,ctx),cookie=login.headers.get('set-cookie')!.split(';')[0];
  (dom.window as any).fetch=(path:string,init:any)=>worker.fetch(new Request(base+path,{...init,headers:{...init.headers,Origin:base,Cookie:cookie}}),env,ctx);
  dom.window.eval(fs.readFileSync('public/app.js','utf8'));await until(()=>!!doc.querySelector('[data-action="discover"]'));
  assert.equal(doc.querySelector('#outreach-state'),null);assert.equal(doc.querySelector('[data-open]'),null);assert.equal(doc.querySelector('.workspace-notice'),null);
  await click('[data-view="products"]');await until(()=>!!doc.querySelector('[data-product-new]'));
  await click('[data-product-new]');await until(()=>!!doc.querySelector('#product-form'));
  for(const [key,value]of Object.entries({...input,name:'Saved through UI'}))(doc.querySelector('#product-form [name="'+key+'"]') as HTMLInputElement).value=value;
  (doc.querySelector('#product-form') as HTMLFormElement).dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));
  await until(()=>!!doc.querySelector('.product-research h2')?.textContent?.includes('Saved through UI'));
  const saved=(await productList(env)).find(p=>p.name==='Saved through UI')!;assert.ok(saved);assert.equal(saved.prospecting_paused,undefined);assert.equal((await all(await scopeProduct(env,saved),'SELECT * FROM jobs')).length,0);
  assert.equal(doc.querySelector('[data-product-pause]'),null);
  await click('[data-product-open="'+b.id+'"]');await until(()=>doc.querySelector('#breadcrumb')?.textContent==='Product B / Prospects');
  assert.equal(doc.querySelector('[data-discovery-control]'),null);
  assert.equal((await settings(await scopeProduct(env,b))).prospectingPaused,undefined);
  assert.equal((await settings(env)).prospectingPaused,undefined);
  assert.equal((await all(env,'SELECT * FROM ai_attempts')).length,0);

 }finally{dom.window.close();close();}
});
