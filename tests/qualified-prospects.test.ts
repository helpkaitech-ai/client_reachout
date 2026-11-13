import fs from 'node:fs';
import worker from '../src/index';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {database,readyLead,readyDraft,testSettings} from './helpers';
import {all,one,run,settings,now,day,claimResearchBusiness} from '../src/db';
import {saveProduct,product,scopeProduct} from '../src/products';
import {tick,processAvailableJobs,scheduleResearch} from '../src/engine';
import {startDiscovery} from '../src/discovery';
import {qualifiedToday,backfillAdmissions,recordAdmission,admissionAvailable} from '../src/qualified-prospects';
import {prospectPage} from '../src/prospects';
import {fixtureUseCase,mockOpenAI,sourceUrls,businessReport} from './openai-fixture';
import {discoveryProgress} from '../src/discovery-cycles';
import {prepareInitialContact} from '../src/intelligence';

const page=new URL('https://outreach.example.com/api/prospects');
async function setup(extra:any={}){
 const db=database();Object.assign(db.env,{OPENAI_API_KEY:'mock',ENABLE_AUTOMATION:'true',AI_STAGES_PER_CYCLE:'3'});
 const p=await saveProduct(db.env,{name:'Reporting product',website:'https://product.example.com',description:'Review prepared spreadsheet exports and reports',sender_email:'data@prepyr.com'});
 await run(db.env,"UPDATE products SET state='approved',approved_revision=revision,analysis=? WHERE id=?",JSON.stringify({useCases:[fixtureUseCase]}),p.id);
 const scope=await scopeProduct(db.env,await product(db.env,p.id));
 await run(scope,'UPDATE settings SET data=?',JSON.stringify({...testSettings,locationIds:['city:london'],campaigns:[{query:'recurring reporting professionals',location:'London, UK',country:'GB',timezone:'Europe/London',enabled:true}],...extra}));
 return {...db,scope,p};
}
async function eligible(scope:any,company='Ready Company',email='ready@example.org'){
 const lead=await readyLead(scope,{company,email,website:'https://'+email.split('@')[1]});
 await run(scope,"UPDATE leads SET dossier=?,contact_status='publicly_sourced',contact_evidence=? WHERE id=?",JSON.stringify({qualified:true}),JSON.stringify({identityConfirmed:true,evidenceType:'opened_page',sourceUrl:'https://pumps.example.com/contact',excerpt:'Contact '+email}),lead.id);
 const draft=await readyDraft(scope,lead);await run(scope,"UPDATE drafts SET status='pending',approved_hash=NULL WHERE id=?",draft.id);return {lead,draft};
}

for(const productWorkspace of [true,false])for(const contactFailure of ['missing','snippet','conflicting'] as const)test(`${productWorkspace?'product':'Existing outreach'} stops ${contactFailure} contacts before deep research and never automatically retries their paid stages`,async()=>{
 const x=await setup(),scope=productWorkspace?x.scope:x.env,original=globalThis.fetch,ai=mockOpenAI({noEmail:contactFailure==='missing'});
 globalThis.fetch=(async(url:any,init:any)=>{const request=JSON.parse(init.body),response=await ai.fetcher(url,init);if(contactFailure==='snippet'&&request.text?.format.name?.startsWith('relay_contact_')){const body:any=await response.json(),out=JSON.parse(body.output.at(-1).content[0].text);out.evidenceType='snippet';body.output.at(-1).content[0].text=JSON.stringify(out);return Response.json(body);}return response;}) as typeof fetch;
 try{
  if(!productWorkspace)await run(scope,'INSERT INTO settings(id,data) VALUES(1,?)',JSON.stringify(testSettings));
  const lead=await readyLead(scope,{email:contactFailure==='conflicting'?'other@pumps.example.com':null});await scheduleResearch(scope);
  for(let i=0;i<12;i++)await processAvailableJobs(scope);
  const fresh=await one<any>(scope,'SELECT * FROM leads WHERE id=?',lead.id),job=await one<any>(scope,"SELECT * FROM jobs WHERE kind='research'");
  assert.equal(fresh.status,'not_qualified');assert.equal(fresh.research,null);assert.equal(job.state,'complete');assert.equal((await all(scope,'SELECT * FROM drafts')).length,0);assert.equal((await prospectPage(scope,page)).total,0);
  const stages=(await all<any>(scope,'SELECT stage FROM ai_attempts')).map(a=>a.stage);assert.ok(stages.length>=2&&stages.length<=4);assert.ok(stages.every(s=>s.startsWith('contact_')));assert.equal(ai.calls.filter(c=>c.tools).length,contactFailure==='conflicting'?1:2);
  assert.match((await one<any>(scope,"SELECT detail FROM events WHERE type='candidate_not_qualified'")).detail,/Stopped before deeper business research/);
  const costs=await all(scope,'SELECT * FROM expenses'),calls=ai.calls.length;await scheduleResearch(scope);for(let i=0;i<4;i++)await processAvailableJobs(scope);assert.equal(ai.calls.length,calls);assert.deepEqual(await all(scope,'SELECT * FROM expenses'),costs);assert.equal((await all(scope,'SELECT * FROM messages')).length,0);
 }finally{globalThis.fetch=original;x.close();}
});

test('snippet contact evidence gets one bounded source-opening pass before a valid researched draft is admitted',async()=>{
 const x=await setup(),original=globalThis.fetch,ai=modifyAI((stage,out)=>{if(stage==='contact_extract')out.evidenceType='snippet';});globalThis.fetch=ai.fetcher;
 try{
  await readyLead(x.scope,{email:null});await scheduleResearch(x.scope);for(let i=0;i<12;i++)await processAvailableJobs(x.scope);
  assert.equal((await prospectPage(x.scope,page)).total,1);const stages=(await all<any>(x.scope,'SELECT stage FROM ai_attempts ORDER BY created_at')).map(a=>a.stage);
  assert.equal(stages.filter(s=>s==='contact_expand_search').length,1);assert.ok(stages.indexOf('contact_expand_extract')<stages.indexOf('business_research'));assert.equal(await qualifiedToday(x.scope),1);assert.equal((await all(x.scope,'SELECT * FROM messages')).length,0);
 }finally{globalThis.fetch=original;x.close();}
});

test('an already sourced contact incurs no provider work and saved business research can supply the contact without another web search',async()=>{
 const x=await setup(),original=globalThis.fetch,ai=mockOpenAI();globalThis.fetch=ai.fetcher;
 try{
  const existing=await eligible(x.scope,'Sourced company','buyer@pumps.example.com');const contact=await prepareInitialContact(x.scope,await settings(x.scope),existing.lead,{jobId:'existing',paidCalls:0});assert.equal(contact!.email,'buyer@pumps.example.com');assert.equal(ai.calls.length,0);
  await run(x.scope,'DELETE FROM drafts WHERE lead_id=?',existing.lead.id);await run(x.scope,'DELETE FROM leads WHERE id=?',existing.lead.id);
  const saved=await readyLead(x.scope,{email:null});await run(x.scope,'UPDATE leads SET research=? WHERE id=?',JSON.stringify({report:businessReport,sources:sourceUrls.map(url=>({url,title:'Saved source'})),gatheredAt:now()}),saved.id);
  const recovered=await prepareInitialContact(x.scope,await settings(x.scope),saved,{jobId:'saved-contact',paidCalls:0});assert.equal(recovered!.email,'buyer@pumps.example.com');assert.equal(ai.calls.length,1);assert.equal(ai.calls[0].tools,undefined);assert.equal((await all(x.scope,'SELECT * FROM messages')).length,0);
 }finally{globalThis.fetch=original;x.close();}
});
function modifyAI(transform:(stage:string,out:any,input:any)=>void){
 const ai=mockOpenAI(),calls:any[]=[];
 const fetcher=(async(url:any,init:any)=>{const input=JSON.parse(init.body),response=await ai.fetcher(url,init);calls.push(input);const stage=input.text?.format.name?.replace('relay_','')||'';
  if(stage){const data:any=await response.json(),last=data.output.at(-1).content[0];const out=JSON.parse(last.text);transform(stage,out,input);last.text=JSON.stringify(out);return Response.json(data);}return response;
 }) as typeof fetch;
 return {fetcher,calls};
}

test('only complete qualified drafts are visible and counted; hidden candidates and sent history remain stored',async()=>{
 const x=await setup();try{
  const good=await eligible(x.scope);const bad=await eligible(x.scope,'Held','held@example.org');await run(x.scope,"UPDATE drafts SET subject='',body='Hi Held,',quality_hold='Insufficient evidence' WHERE id=?",bad.draft.id);
  const pending=await readyLead(x.scope,{company:'Research candidate',email:'candidate@example.org'});await scheduleResearch(x.scope);
  let result:any=await prospectPage(x.scope,page);assert.equal(result.total,1);assert.equal(result.rows[0].id,good.lead.id);assert.equal(result.counts.attention,0);
  await backfillAdmissions(x.scope);assert.equal(await qualifiedToday(x.scope),1);assert.equal((await all(x.scope,'SELECT * FROM leads')).length,3);assert.ok(await one(x.scope,'SELECT id FROM jobs WHERE lead_id=?',pending.id));
  await run(x.scope,"UPDATE drafts SET status='sent' WHERE id=?",good.draft.id);assert.equal((await prospectPage(x.scope,new URL(page+'?group=sent'))).total,1);
 }finally{x.close();}
});

test('invalid stored evidence fails closed without breaking the entire prospect page',async()=>{
 const x=await setup();try{
  const a=await eligible(x.scope,'Bad JSON','a@example.org'),b=await eligible(x.scope,'Bad contact','b@example.org'),c=await eligible(x.scope,'Bad evidence','c@example.org');
  await run(x.scope,"UPDATE leads SET dossier='not json' WHERE id=?",a.lead.id);await run(x.scope,"UPDATE leads SET contact_evidence='not json' WHERE id=?",b.lead.id);await run(x.scope,'UPDATE drafts SET evidence=? WHERE id=?',JSON.stringify(['untrusted text',null]),c.draft.id);
  assert.equal((await prospectPage(x.scope,page)).total,0);assert.equal(await qualifiedToday(x.scope),0);
 }finally{x.close();}
});

for(const failure of ['fit','empty','assessment','contact'] as const)test('a '+failure+' failure creates no empty or held draft and does not count toward the target',async()=>{
 const x=await setup(),original=globalThis.fetch,ai=modifyAI((stage,out)=>{if(failure==='fit'&&stage==='solution_design'){out.qualified=false;out.qualificationReason='No supported reporting workflow';}if(failure==='empty'&&stage==='draft_generate'){out.subject='';out.body='';}if(failure==='assessment'&&stage==='draft_assess'){out.specific=false;out.reason='Generic pitch';}if(failure==='contact'&&stage.startsWith('contact_'))out.evidenceType='snippet';});globalThis.fetch=ai.fetcher;
 try{await readyLead(x.scope);await scheduleResearch(x.scope);for(let i=0;i<12;i++)await processAvailableJobs(x.scope);
  assert.equal((await all(x.scope,'SELECT * FROM drafts')).length,0);assert.equal((await prospectPage(x.scope,page)).total,0);assert.equal(await qualifiedToday(x.scope),0);
  assert.equal((await one<any>(x.scope,'SELECT status FROM leads')).status,'not_qualified');
  assert.equal((await one<any>(x.scope,"SELECT state FROM jobs WHERE kind='research'")).state,'complete');
  if(failure==='fit'||failure==='contact')assert.equal(ai.calls.some(c=>c.text?.format.name==='relay_draft_generate'),false);
  assert.equal((await all(x.scope,'SELECT * FROM messages')).length,0);
 }finally{globalThis.fetch=original;x.close();}
});

test('original discovery URL, excerpt and role reach deep research and all decisions share qualification guidance',async()=>{
 const x=await setup(),original=globalThis.fetch,ai=mockOpenAI();globalThis.fetch=ai.fetcher;
 try{await startDiscovery(x.scope,await settings(x.scope));for(let i=0;i<13;i++)await tick(x.scope);
  const research=ai.calls.find(c=>c.tools&&c.instructions.includes('Cross-check the supplied discovery source URL'));
  assert.ok(research);const input=JSON.parse(research.input);assert.equal(input.discoveryEvidence.sourceUrl,sourceUrls[0]);assert.ok(input.discoveryEvidence.fitEvidence);assert.ok(input.discoveryEvidence.evidenceExcerpt);
  for(const stage of ['discover_extract','solution_design','draft_generate','draft_assess'])assert.ok(ai.calls.find(c=>c.text?.format.name==='relay_'+stage)?.instructions.includes('Apply the same qualification standard'));
  const result:any=await prospectPage(x.scope,page);assert.equal(result.total,1);assert.equal(result.rows[0].email_status,'pending');assert.equal(await qualifiedToday(x.scope),1);
 }finally{globalThis.fetch=original;x.close();}
});

test('qualified reporting excludes rejected candidates; standalone imports have no daily admission cap',async()=>{
 const x=await setup({dailyLeadLimit:2,dailyNewLimit:2});try{
  for(let i=0;i<20;i++)await readyLead(x.scope,{company:'Rejected '+i,email:'rejected'+i+'@example.org'});
  const a=await eligible(x.scope,'Good A','gooda@example.org'),b=await eligible(x.scope,'Good B','goodb@example.org');
  await recordAdmission(x.scope,a.lead.id,a.draft.id);await recordAdmission(x.scope,a.lead.id,a.draft.id);await recordAdmission(x.scope,b.lead.id,b.draft.id);
  assert.equal(await qualifiedToday(x.scope),2);assert.equal(await admissionAvailable(x.scope,await settings(x.scope),'next'),true);
  await run(x.scope,"UPDATE drafts SET quality_hold='No longer valid' WHERE id=?",a.draft.id);assert.equal(await qualifiedToday(x.scope),1);assert.equal(await admissionAvailable(x.scope,await settings(x.scope),'next'),true);
 }finally{x.close();}
});

test('completed searches allow a fresh requested target on the same day, excluding earlier admissions',async()=>{
 const x=await setup();try{
  await startDiscovery(x.scope,await settings(x.scope),undefined,undefined,true,false,3);const batch=(await one<any>(x.scope,'SELECT id FROM discovery_batches'))!.id;
  await run(x.scope,"UPDATE discovery_batches SET state='complete'");await run(x.scope,"UPDATE jobs SET state='complete'");
  for(let i=0;i<3;i++){const q=await eligible(x.scope,'Good '+i,'good'+i+'@example.org');await recordAdmission(x.scope,q.lead.id,q.draft.id);await run(x.scope,"INSERT INTO discovery_candidates(id,batch_id,entity_key,data,outcome,lead_id,created_at) VALUES(?,?,?,'{}','imported',?,?)",'c'+i,batch,'k'+i,q.lead.id,now());}
  assert.equal((await discoveryProgress(x.scope,await settings(x.scope))).qualified,3);
  assert.equal((await startDiscovery(x.scope,await settings(x.scope),undefined,undefined,true,true)).state,'manual_only');
  assert.equal((await all(x.scope,'SELECT * FROM discovery_cycles')).length,1);
  assert.equal((await startDiscovery(x.scope,await settings(x.scope),undefined,undefined,true,false,2)).state,'queued');
  const progress=await discoveryProgress(x.scope,await settings(x.scope));assert.equal(progress.target,2);assert.equal(progress.qualified,0);assert.equal((await all(x.scope,'SELECT * FROM discovery_cycles')).length,2);assert.equal((await prospectPage(x.scope,page)).total,3);
 }finally{x.close();}
});

test('legacy pause settings cannot block an explicit search; idle ticks do not spend',async()=>{
 const x=await setup({prospectingPaused:true,discoveryPaused:true}),original=globalThis.fetch;let calls=0;globalThis.fetch=(async()=>{calls++;throw Error('No live provider allowed');}) as typeof fetch;
 try{await tick(x.scope);assert.equal((await startDiscovery(x.scope,await settings(x.scope))).state,'queued');assert.equal((await all(x.scope,'SELECT * FROM discovery_cycles')).length,1);assert.equal(calls,0);}finally{globalThis.fetch=original;x.close();}
});

for(const {automatic,rejectedBatches} of [{automatic:true,rejectedBatches:1},{automatic:false,rejectedBatches:1},{automatic:false,rejectedBatches:7}])test('an explicitly requested campaign with legacy automation '+automatic+' replaces '+rejectedBatches*4+' rejected candidates with twelve distinct fully drafted prospects without sending',async()=>{
 const x=await setup({researchAutomation:automatic,discoveryPaused:!automatic}),original=globalThis.fetch,ai=mockOpenAI();let batch=0;
 const address=(company:string)=>'team@'+company.toLowerCase().replace(/\s/g,'')+'.example.org';
 globalThis.fetch=(async(url:any,init:any)=>{
  const request=JSON.parse(init.body),input=JSON.parse(request.input),response=await ai.fetcher(url,init),data:any=await response.json(),last=data.output.at(-1).content[0],stage=request.text?.format.name?.replace('relay_','')||'';
  if(request.tools){
   if(input.campaign){batch++;last.text+='\nDirectory profiles: '+Array.from({length:4},(_,i)=>batch<=rejectedBatches?'Rejected '+((batch-1)*4+i):'Qualified '+((batch-rejectedBatches-1)*4+i)).join(', ');last.text+='\n'+Array.from({length:4},(_,i)=>{const company=batch<=rejectedBatches?'Rejected '+((batch-1)*4+i):'Qualified '+((batch-rejectedBatches-1)*4+i);return 'For pump enquiries email '+address(company);}).join('\n');}
   const company=input.company||input.business?.company;
   if(company)last.text=last.text.replaceAll('buyer@pumps.example.com',address(company));
  }else{
   const out=JSON.parse(last.text);
   if(stage==='discover_extract'){const template=out.candidates[0];out.candidates=Array.from({length:4},(_,i)=>{const company=batch<=rejectedBatches?'Rejected '+((batch-1)*4+i):'Qualified '+((batch-rejectedBatches-1)*4+i);return {...template,company,website:'https://'+address(company).split('@')[1],publicContact:{...template.publicContact,email:address(company),excerpt:'For pump enquiries email '+address(company)}};});}
   if(stage.startsWith('contact_')){const email=input.report.match(/team@[a-z0-9.]+\.example\.org/)?.[0];if(email){out.email=email;out.excerpt='For pump enquiries email '+email;}}
   if(stage==='solution_design'&&input.business.startsWith('Rejected')){out.qualified=false;out.qualificationReason='Original source did not establish the approved workflow';}
   last.text=JSON.stringify(out);
  }
  return Response.json(data);
 }) as typeof fetch;
 try{
  assert.equal((await startDiscovery(x.scope,await settings(x.scope),undefined,undefined,true)).state,'queued');
  for(let i=0;i<180;i++){await tick(x.scope);if(await qualifiedToday(x.scope)===12)break;}
  assert.equal(await qualifiedToday(x.scope),12);const result:any=await prospectPage(x.scope,page);assert.equal(result.total,12);assert.equal(new Set(result.rows.map((l:any)=>l.email)).size,12);assert.equal(result.counts.attention,0);
  assert.equal((await all(x.scope,"SELECT * FROM leads WHERE status='not_qualified'")).length,rejectedBatches*4);assert.equal((await all(x.scope,'SELECT * FROM drafts')).length,12);
  assert.equal((await all(x.scope,'SELECT * FROM discovery_batches')).length,rejectedBatches+3);assert.equal((await all(x.scope,'SELECT * FROM discovery_cycles')).length,1);
  assert.equal((await all(x.scope,'SELECT * FROM research_claims')).length,rejectedBatches*4+12);assert.equal((await all(x.scope,'SELECT * FROM messages')).length,0);
  assert.equal((await all(x.env,'SELECT * FROM leads')).length,0);assert.equal((await startDiscovery(x.scope,await settings(x.scope),undefined,undefined,true,true)).state,'manual_only');
  if(automatic){
   assert.equal((await startDiscovery(x.scope,await settings(x.scope),undefined,undefined,true,false,3)).state,'queued');
   for(let i=0;i<50;i++){await tick(x.scope);if((await discoveryProgress(x.scope,await settings(x.scope))).qualified===3)break;}
   for(let i=0;i<3;i++)await tick(x.scope);
   assert.equal(await qualifiedToday(x.scope),15);const progress=await discoveryProgress(x.scope,await settings(x.scope));assert.equal(progress.qualified,3);assert.equal(progress.target,3);assert.equal((await all(x.scope,'SELECT * FROM discovery_cycles')).length,2);assert.equal((await all(x.scope,'SELECT * FROM messages')).length,0);
  }

 }finally{globalThis.fetch=original;x.close();}
});

test('standalone qualified drafts are not limited by legacy daily caps',async()=>{
 const x=await setup({dailyLeadLimit:12,dailyNewLimit:1});try{
  for(let i=0;i<12;i++){
   assert.equal(await admissionAvailable(x.scope,await settings(x.scope),'next-'+i),true);
   const q=await eligible(x.scope,'Distinct '+i,'distinct'+i+'@example.org');
   await recordAdmission(x.scope,q.lead.id,q.draft.id);
  }
  assert.equal(await qualifiedToday(x.scope),12);
  assert.equal(await admissionAvailable(x.scope,await settings(x.scope),'thirteenth'),true);
 }finally{x.close();}
});

test('cancelled search after a product edit cannot block a new manual search',async()=>{
 const x=await setup();try{
  const first=await startDiscovery(x.scope,await settings(x.scope),undefined,'old-profile');
  await run(x.scope,"UPDATE jobs SET state='cancelled' WHERE id=?",'discovery:'+first.runId);
  await run(x.scope,"UPDATE discovery_cycles SET completed_at=?",now());
  const next=await startDiscovery(x.scope,await settings(x.scope),undefined,'new-profile');
  assert.equal(next.runId,'new-profile');assert.equal(next.state,'queued');
 }finally{x.close();}
});


test('per-search research and empty-result bounds stop continuations but allow a fresh user request',async()=>{
 const x=await setup({discoveryResults:10});try{
  await startDiscovery(x.scope,await settings(x.scope),undefined,undefined,true,false,2);const batch=await one<any>(x.scope,'SELECT * FROM discovery_batches');
  const lead=await readyLead(x.scope,{status:'not_qualified'});await run(x.scope,"INSERT INTO discovery_candidates(id,batch_id,entity_key,data,outcome,lead_id,created_at) VALUES('limit-c',?,'limit-k','{}','imported',?,?)",batch.id,lead.id,now());await claimResearchBusiness(x.scope,lead.id,100);
  await run(x.scope,'UPDATE discovery_cycles SET research_limit=1');await run(x.scope,"UPDATE discovery_batches SET state='complete'");await run(x.scope,"UPDATE jobs SET state='complete'");
  assert.equal((await startDiscovery(x.scope,await settings(x.scope),undefined,undefined,true,true)).state,'manual_only');assert.equal((await all(x.scope,'SELECT * FROM discovery_cycles')).length,1);
  assert.equal((await startDiscovery(x.scope,await settings(x.scope),undefined,undefined,true,false,5)).state,'queued');assert.equal((await discoveryProgress(x.scope,await settings(x.scope))).attempts,0);
  const cycle=await one<any>(x.scope,'SELECT * FROM discovery_cycles ORDER BY rowid DESC LIMIT 1');await run(x.scope,'UPDATE discovery_cycles SET research_limit=1 WHERE id=?',cycle.id);
  for(let i=0;i<5;i++){await run(x.scope,"UPDATE jobs SET state='complete'");await run(x.scope,"UPDATE discovery_batches SET state='no_results'");assert.equal((await startDiscovery(x.scope,await settings(x.scope),undefined,undefined,true,true)).state,'queued');}
  await run(x.scope,"UPDATE jobs SET state='complete'");await run(x.scope,"UPDATE discovery_batches SET state='no_results'");assert.equal((await startDiscovery(x.scope,await settings(x.scope),undefined,undefined,true,true)).state,'manual_only');assert.equal((await all(x.scope,'SELECT * FROM discovery_cycles')).length,2);
 }finally{x.close();}
});


test('product and targeting edits keep saved qualified prospects listed without changing their drafts or clearing actual holds',async()=>{
 const x=await setup();try{
  const good=await eligible(x.scope),held=await eligible(x.scope,'Held','held@example.org');
  await recordAdmission(x.scope,good.lead.id,good.draft.id);
  await run(x.scope,"UPDATE drafts SET quality_hold='Insufficient evidence' WHERE id=?",held.draft.id);
  const call=(path:string,body?:any,cookie='')=>worker.fetch(new Request(x.env.APP_URL+path,{method:body===undefined?'GET':'POST',headers:{Origin:x.env.APP_URL!,'X-Requested-With':'Prepyr',Cookie:cookie},...(body===undefined?{}:{body:JSON.stringify(body)})}),x.env,{waitUntil:()=>{}} as any);
  const login=await call('/api/login',{password:x.env.ADMIN_PASSWORD}),cookie=login.headers.get('set-cookie')!.split(';')[0];
  for(const change of ['description','remarks','customerDescription','preferences']){
   const current=await product(x.env,x.p.id),input={...current,[change]:'Changed '+change};
   const response=change==='preferences'?await call('/api/settings/preferences?product='+x.p.id,{...await settings(x.scope),freeOffer:'A free sample report using one prepared spreadsheet export'},cookie):await call('/api/products/'+x.p.id,input,cookie);
   assert.equal(response.status,200,change+': '+await response.text());
   const list=await call('/api/prospects?product='+x.p.id,undefined,cookie),page=await list.json() as any;
   assert.equal(list.status,200);assert.deepEqual(page.rows.map((r:any)=>r.id),[good.lead.id],change);assert.equal(page.rows[0].email_status,'pending');
   const saved=await one<any>(x.scope,'SELECT * FROM drafts WHERE id=?',good.draft.id);
   assert.equal(saved.body,good.draft.body);assert.equal(saved.subject,good.draft.subject);assert.equal(saved.quality_hold,'');assert.equal(saved.approved_hash,null);
   assert.equal((await one<any>(x.scope,'SELECT quality_hold FROM drafts WHERE id=?',held.draft.id)).quality_hold,'Insufficient evidence');
  }
  assert.equal((await all(x.scope,'SELECT * FROM ai_attempts')).length,0);assert.equal((await all(x.scope,'SELECT * FROM messages')).length,0);
 }finally{x.close();}
});

test('edit-hold recovery restores only previously admitted drafts and preserves real quality failures',async()=>{
 const x=await setup();try{
  const restored=await eligible(x.scope),unknown=await eligible(x.scope,'Unqualified','unknown@example.org'),held=await eligible(x.scope,'Held','held@example.org');
  await recordAdmission(x.scope,restored.lead.id,restored.draft.id);await recordAdmission(x.scope,held.lead.id,held.draft.id);
  await run(x.scope,"UPDATE drafts SET quality_hold='Product details changed; review or improve this draft against the refreshed profile'");
  await run(x.scope,"UPDATE drafts SET quality_hold='Insufficient evidence' WHERE id=?",held.draft.id);
  assert.equal((await prospectPage(x.scope,page)).total,0);
  await run(x.scope,fs.readFileSync('migrations/0017_preserve_product_edit_prospects.sql','utf8'));
  assert.deepEqual((await prospectPage(x.scope,page)).rows.map((r:any)=>r.id),[restored.lead.id]);
  assert.equal((await one<any>(x.scope,'SELECT quality_hold FROM drafts WHERE id=?',held.draft.id)).quality_hold,'Insufficient evidence');
  assert.match((await one<any>(x.scope,'SELECT quality_hold FROM drafts WHERE id=?',unknown.draft.id)).quality_hold,/Product details changed/);
  assert.equal((await one<any>(x.scope,'SELECT body FROM drafts WHERE id=?',restored.draft.id)).body,restored.draft.body);
 }finally{x.close();}
});
