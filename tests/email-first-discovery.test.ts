import {test} from 'node:test';
import worker from '../src/index';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {database,testSettings,readyLead,readyDraft} from './helpers';
import {mockOpenAI,fixtureUseCase,fixtureProductFit,businessReport,sourceUrls} from './openai-fixture';
import {saveProduct,product,scopeProduct} from '../src/products';
import {all,one,run,settings,now} from '../src/db';
import {startDiscovery,runDiscovery} from '../src/discovery';
import {processAvailableJobs,tick} from '../src/engine';
import {publicContactReady} from '../src/qualified-prospects';
import {productFitProblems,supportedCapability} from '../src/product-fit';
import {StageYield} from '../src/ai';

async function setup(productWorkspace=true){
 const db=database();Object.assign(db.env,{OPENAI_API_KEY:'fixture',AI_STAGES_PER_CYCLE:'3'});let scope=db.env;
 if(productWorkspace){
  const p=await saveProduct(db.env,{name:'Pump intake',website:'https://pumps.example.com',description:'Capture pump specifications for quotation requests',sender_email:'data@prepyr.com'});
  await run(db.env,"UPDATE products SET state='approved',approved_revision=revision,analysis=? WHERE id=?",JSON.stringify({useCases:[fixtureUseCase]}),p.id);
  scope=await scopeProduct(db.env,await product(db.env,p.id));
 }
 await run(scope,'INSERT INTO settings(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',JSON.stringify({...testSettings,locationIds:['city:london'],campaigns:[{query:'pump suppliers',location:'London, UK',country:'GB',timezone:'Europe/London',enabled:true}]}));
 return {...db,scope};
}
function aiWith(transform:(stage:string,out:any)=>void){
 const ai=mockOpenAI();return {...ai,fetcher:(async(url:any,init:any)=>{
  const input=JSON.parse(init.body),response=await ai.fetcher(url,init),stage=input.text?.format.name?.replace('relay_','');
  if(!stage)return response;
  const data:any=await response.json(),content=data.output.at(-1).content[0],out=JSON.parse(content.text);
  transform(stage,out);content.text=JSON.stringify(out);return Response.json(data);
 }) as typeof fetch};
}
for(const productWorkspace of [true,false])test(`${productWorkspace?'product':'Existing outreach'} discovers an email-sourced prospect and avoids repeating contact searches`,async()=>{
 const x=await setup(productWorkspace),original=globalThis.fetch,ai=mockOpenAI();globalThis.fetch=ai.fetcher;
 try{
  await startDiscovery(x.scope,await settings(x.scope));await processAvailableJobs(x.scope);await processAvailableJobs(x.scope);
  const lead=await one<any>(x.scope,'SELECT * FROM leads');assert.ok(lead);assert.equal(publicContactReady(lead),true);
  assert.equal(JSON.parse(lead.contact_evidence).deliverability,'unknown');
  for(let i=0;i<6;i++)await tick(x.scope);
  assert.equal((await all(x.scope,'SELECT * FROM drafts')).length,1);
  assert.equal(ai.calls.some(c=>c.text?.format.name?.startsWith('relay_contact_')),false);
  assert.ok(ai.calls.find(c=>c.tools&&JSON.parse(c.input).campaign)?.tools[0].search_context_size==='high');
  assert.equal((await all(x.scope,'SELECT * FROM messages')).length,0);
 }finally{globalThis.fetch=original;x.close();}
});

for(const productWorkspace of [true,false])for(const failure of ['missing','guessed','snippet','unlisted_source','unconfirmed_identity','inappropriate_mailbox'])test(`${productWorkspace?'product':'Existing outreach'} rejects ${failure} contacts before admitting a research candidate`,async()=>{
 const x=await setup(productWorkspace),original=globalThis.fetch,ai=aiWith((stage,out)=>{
  if(stage!=='discover_extract')return;const c=out.candidates[0].publicContact;
  if(failure==='missing')c.email='';if(failure==='guessed')c.email='guessed@pumps.example.com';
  if(failure==='snippet')c.evidenceType='snippet';if(failure==='unlisted_source')c.sourceUrl='https://unconsulted.example.org/contact';
  if(failure==='unconfirmed_identity')c.identityConfirmed=false;if(failure==='inappropriate_mailbox'){c.email='privacy@pumps.example.com';c.excerpt='For pump enquiries email privacy@pumps.example.com';}
 });globalThis.fetch=(async(url:any,init:any)=>{const r=await ai.fetcher(url,init);if(failure==='inappropriate_mailbox'&&JSON.parse(init.body).tools){const data:any=await r.json();data.output.at(-1).content[0].text=data.output.at(-1).content[0].text.replaceAll('buyer@pumps.example.com','privacy@pumps.example.com');return Response.json(data);}return r;}) as typeof fetch;
 try{
  await startDiscovery(x.scope,await settings(x.scope));for(let i=0;i<3;i++)await processAvailableJobs(x.scope);
  assert.equal((await all(x.scope,'SELECT * FROM leads')).length,0);
  assert.equal((await all(x.scope,'SELECT * FROM research_claims')).length,0);
  assert.equal((await one<any>(x.scope,'SELECT outcome FROM discovery_candidates'))!.outcome,'no_public_email');
  assert.equal(ai.calls.length,2);
 }finally{globalThis.fetch=original;x.close();}
});

for(const failure of ['no_mapping','unknown_use_case','invented_capability','snippet','paraphrase','explicit_mismatch'])test(`a public email does not admit a candidate with ${failure} product fit`,async()=>{
 const x=await setup(),original=globalThis.fetch,ai=aiWith((stage,out)=>{
  if(stage!=='discover_extract')return;const c=out.candidates[0];
  if(failure==='no_mapping')delete c.productFit;
  if(failure==='unknown_use_case')c.productFit.useCaseId='unrelated';
  if(failure==='invented_capability')c.productFit.productCapability='Automatic enterprise accounting integration';
  if(failure==='snippet')c.productFit.evidenceType='snippet';
  if(failure==='paraphrase')c.productFit.excerpt='The business needs quotation intake automation, which it does not have.';
  if(failure==='explicit_mismatch')c.productFit.disqualifierFound=true;
 });globalThis.fetch=ai.fetcher;
 try{
  await startDiscovery(x.scope,await settings(x.scope));for(let i=0;i<3;i++)await processAvailableJobs(x.scope);
  assert.equal((await all(x.scope,'SELECT * FROM leads')).length,0);
  const candidate=await one<any>(x.scope,'SELECT outcome,data FROM discovery_candidates');assert.equal(candidate.outcome,'not_a_fit');assert.ok(JSON.parse(candidate.data).discoveryIssues.length);
  assert.equal(ai.calls.length,2);
 }finally{globalThis.fetch=original;x.close();}
});

test('source-proven contacts cannot compensate for an invented capability during independent enrichment',async()=>{
 const x=await setup(),original=globalThis.fetch,ai=aiWith((stage,out)=>{
  if(['solution_design','solution_evidence_repair'].includes(stage))out.productFit.productCapability='Build a custom enterprise integration';
 });globalThis.fetch=ai.fetcher;
 try{
  await startDiscovery(x.scope,await settings(x.scope));for(let i=0;i<8;i++)await tick(x.scope);
  assert.equal((await all(x.scope,'SELECT * FROM drafts')).length,0);
  const lead=await one<any>(x.scope,'SELECT * FROM leads');assert.equal(lead.status,'not_qualified');
  assert.match((await one<any>(x.scope,"SELECT detail FROM events WHERE type='candidate_not_qualified'"))!.detail,/capability does not match/);
  assert.equal(ai.calls.some(c=>c.text?.format.name==='relay_draft_generate'),false);
 }finally{globalThis.fetch=original;x.close();}
});

test('a discovery checkpoint crash recovers the same sourced lead without another paid request',async()=>{
 const x=await setup(false),original=globalThis.fetch,ai=mockOpenAI();globalThis.fetch=ai.fetcher;
 try{
  await startDiscovery(x.scope,await settings(x.scope));const job=(await one<any>(x.scope,"SELECT * FROM jobs WHERE kind='discover_search'"))!;
  await assert.rejects(runDiscovery(x.scope,await settings(x.scope),job,{jobId:job.id,paidCalls:0}),StageYield);
  x.sqlite.exec("CREATE TRIGGER simulate_discovery_crash BEFORE INSERT ON discovery_candidates BEGIN SELECT RAISE(ABORT,'simulated checkpoint crash'); END;");
  await assert.rejects(runDiscovery(x.scope,await settings(x.scope),job,{jobId:job.id,paidCalls:0}),/checkpoint crash/);
  const lead=await one<any>(x.scope,'SELECT * FROM leads');assert.ok(lead);assert.equal(publicContactReady(lead),true);assert.equal(ai.calls.length,2);
  x.sqlite.exec('DROP TRIGGER simulate_discovery_crash');
  await runDiscovery(x.scope,await settings(x.scope),job,{jobId:job.id,paidCalls:0});
  assert.equal((await all(x.scope,'SELECT * FROM leads')).length,1);assert.equal((await one<any>(x.scope,'SELECT lead_id FROM discovery_candidates'))!.lead_id,lead.id);assert.equal(ai.calls.length,2);
 }finally{globalThis.fetch=original;x.close();}
});

test('capability provenance must quote a consulted product source or the owner description',()=>{
 const product={description:'Our product captures quotation specifications for pump suppliers.',remarks:''};
 assert.equal(supportedCapability(fixtureUseCase,product,'The product captures pump flange and pressure specifications for quotation requests.',sourceUrls.map(url=>({url}))),true);
 assert.equal(supportedCapability(fixtureUseCase,product,'Nothing about that feature.',sourceUrls.map(url=>({url}))),false);
 assert.equal(supportedCapability({...fixtureUseCase,capabilityEvidence:{sourceType:'owner_description',sourceUrl:'',excerpt:product.description}},product,'',[]),true);
});

test('email-first migration preserves text and sent history while holding older unsent product drafts for renewed fit review',async()=>{
 const x=await setup();try{
  const p=await one<any>(x.env,'SELECT * FROM products');
  const initial=await readyDraft(x.env,await readyLead(x.env));await run(x.env,"UPDATE drafts SET free_offer=? WHERE id=?",JSON.stringify({type:'product'}),initial.id);
  const sent=await readyDraft(x.env,await readyLead(x.env,{company:'Already sent',email:'sent@example.org'}));await run(x.env,"UPDATE drafts SET status='sent',free_offer=? WHERE id=?",JSON.stringify({type:'product'}),sent.id);
  x.sqlite.exec(readFileSync('migrations/0013_email_first_product_fit.sql','utf8'));
  const updated=await product(x.env,p.id);assert.equal(updated.state,'draft');assert.equal(updated.revision,p.revision+1);
  const draft=await one<any>(x.env,'SELECT * FROM drafts WHERE id=?',initial.id);assert.equal(draft.body,initial.body);assert.equal(draft.status,'pending');assert.equal(draft.approved_hash,null);assert.match(draft.quality_hold,/new fit review/);
  assert.equal((await one<any>(x.env,'SELECT status FROM drafts WHERE id=?',sent.id))!.status,'sent');
 }finally{x.close();}
});


test('older held drafts remain accessible for reassessment without appearing as qualified prospects',async()=>{
 const x=await setup();try{
  const lead=await readyLead(x.scope),draft=await readyDraft(x.scope,lead);await run(x.scope,"UPDATE drafts SET status='pending',quality_hold='Product-fit rules updated; this earlier draft needs a new fit review' WHERE id=?",draft.id);
  const origin=x.env.APP_URL!,ctx={waitUntil:()=>{}} as unknown as ExecutionContext;
  const login=await worker.fetch(new Request(origin+'/api/login',{method:'POST',headers:{Origin:origin,'X-Requested-With':'Prepyr'},body:JSON.stringify({password:x.env.ADMIN_PASSWORD})}),x.env,ctx);
  const cookie=login.headers.get('set-cookie')!.split(';')[0];
  const response=await worker.fetch(new Request(origin+'/api/dashboard?summary=1&product='+x.scope.PRODUCT_ID,{headers:{Cookie:cookie}}),x.env,ctx);
  assert.equal(response.status,200);const data:any=await response.json();assert.equal(data.reviewDrafts.length,1);assert.equal(data.reviewDrafts[0].id,draft.id);assert.equal(data.metrics.prospects,0);
 }finally{x.close();}
});
