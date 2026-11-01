import {test} from 'node:test';
import assert from 'node:assert/strict';
import {database,readyLead,readyDraft,testSettings} from './helpers';
import {all,one,run,settings,now,day,claimResearchBusiness} from '../src/db';
import {saveProduct,product,scopeProduct} from '../src/products';
import {tick,processAvailableJobs,scheduleResearch} from '../src/engine';
import {startDiscovery} from '../src/discovery';
import {qualifiedToday,backfillAdmissions,recordAdmission,admissionAvailable} from '../src/qualified-prospects';
import {prospectPage} from '../src/prospects';
import {mockOpenAI,sourceUrls} from './openai-fixture';
import {discoveryProgress} from '../src/discovery-cycles';

const page=new URL('https://outreach.example.com/api/prospects');
async function setup(extra:any={}){
 const db=database();Object.assign(db.env,{OPENAI_API_KEY:'mock',ENABLE_AUTOMATION:'true',AI_STAGES_PER_CYCLE:'3'});
 const p=await saveProduct(db.env,{name:'Reporting product',website:'https://product.example.com',description:'Review prepared spreadsheet exports and reports',sender_email:'data@prepyr.com'});
 await run(db.env,"UPDATE products SET state='approved',approved_revision=revision WHERE id=?",p.id);
 const scope=await scopeProduct(db.env,await product(db.env,p.id));
 await run(scope,'UPDATE settings SET data=?',JSON.stringify({...testSettings,campaigns:[{query:'recurring reporting professionals',location:'London, UK',country:'GB',timezone:'Europe/London',enabled:true}],...extra}));
 return {...db,scope,p};
}
async function eligible(scope:any,company='Ready Company',email='ready@example.org'){
 const lead=await readyLead(scope,{company,email,website:'https://'+email.split('@')[1]});
 await run(scope,"UPDATE leads SET dossier=?,contact_status='publicly_sourced',contact_evidence=? WHERE id=?",JSON.stringify({qualified:true}),JSON.stringify({identityConfirmed:true,evidenceType:'opened_page',sourceUrl:'https://pumps.example.com/contact',excerpt:'Contact '+email}),lead.id);
 const draft=await readyDraft(scope,lead);await run(scope,"UPDATE drafts SET status='pending',approved_hash=NULL WHERE id=?",draft.id);return {lead,draft};
}
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
  const research=ai.calls.find(c=>c.tools&&c.instructions.includes('Re-open and verify'));
  assert.ok(research);const input=JSON.parse(research.input);assert.equal(input.discoveryEvidence.sourceUrl,sourceUrls[0]);assert.ok(input.discoveryEvidence.fitEvidence);assert.ok(input.discoveryEvidence.evidenceExcerpt);
  for(const stage of ['discover_extract','solution_design','draft_generate','draft_assess'])assert.ok(ai.calls.find(c=>c.text?.format.name==='relay_'+stage)?.instructions.includes('Apply the same qualification standard'));
  const result:any=await prospectPage(x.scope,page);assert.equal(result.total,1);assert.equal(result.rows[0].email_status,'pending');assert.equal(await qualifiedToday(x.scope),1);
 }finally{globalThis.fetch=original;x.close();}
});

test('private rejected candidates do not consume the daily qualified admission limit; valid distinct drafts do',async()=>{
 const x=await setup({dailyLeadLimit:2,dailyNewLimit:2});try{
  for(let i=0;i<20;i++)await readyLead(x.scope,{company:'Rejected '+i,email:'rejected'+i+'@example.org'});
  const a=await eligible(x.scope,'Good A','gooda@example.org'),b=await eligible(x.scope,'Good B','goodb@example.org');
  await recordAdmission(x.scope,a.lead.id,a.draft.id);await recordAdmission(x.scope,a.lead.id,a.draft.id);await recordAdmission(x.scope,b.lead.id,b.draft.id);
  assert.equal(await qualifiedToday(x.scope),2);assert.equal(await admissionAvailable(x.scope,await settings(x.scope),'next'),false);
  await run(x.scope,"UPDATE drafts SET quality_hold='No longer valid' WHERE id=?",a.draft.id);assert.equal(await qualifiedToday(x.scope),1);assert.equal(await admissionAvailable(x.scope,await settings(x.scope),'next'),true);
 }finally{x.close();}
});

test('replacement discovery bypasses the interval inside an unfinished cycle and stops at research and empty-search bounds',async()=>{
 const x=await setup({dailyResearchLimit:2,discoveryResults:1});try{
  const first:any=await startDiscovery(x.scope,await settings(x.scope));assert.equal(first.state,'queued');await run(x.scope,"UPDATE discovery_batches SET state='no_results'");await run(x.scope,"UPDATE jobs SET state='complete'");
  const second=await startDiscovery(x.scope,await settings(x.scope));assert.equal(second.state,'queued');assert.equal((await all(x.scope,'SELECT * FROM discovery_cycles')).length,1);
  await run(x.scope,"UPDATE discovery_batches SET state='no_results'");await run(x.scope,"UPDATE jobs SET state='complete'");
  await claimResearchBusiness(x.scope,'attempt1',2);await claimResearchBusiness(x.scope,'attempt2',2);assert.equal((await startDiscovery(x.scope,await settings(x.scope))).state,'research_limit');
  await run(x.scope,'DELETE FROM research_claims');
  for(let i=0;i<2;i++){assert.equal((await startDiscovery(x.scope,await settings(x.scope))).state,'queued');await run(x.scope,"UPDATE discovery_batches SET state='no_results'");await run(x.scope,"UPDATE jobs SET state='complete'");}
  assert.equal((await startDiscovery(x.scope,await settings(x.scope))).state,'search_limit');
 }finally{x.close();}
});

test('twelve distinct qualified prospects complete a cycle; rejected candidates do not advance it and the six-day gap stays enforced',async()=>{
 const x=await setup();try{
  await startDiscovery(x.scope,await settings(x.scope));const batch=(await one<any>(x.scope,'SELECT id FROM discovery_batches'))!.id;
  await run(x.scope,"UPDATE discovery_batches SET state='complete'");await run(x.scope,"UPDATE jobs SET state='complete'");
  for(let i=0;i<12;i++){const q=await eligible(x.scope,'Good '+i,'good'+i+'@example.org');await recordAdmission(x.scope,q.lead.id,q.draft.id);await run(x.scope,"INSERT INTO discovery_candidates(id,batch_id,entity_key,data,outcome,lead_id,created_at) VALUES(?,?,?,'{}','imported',?,?)",'c'+i,batch,'k'+i,q.lead.id,now());}
  assert.equal((await startDiscovery(x.scope,await settings(x.scope))).state,'cooldown');assert.equal(await qualifiedToday(x.scope),12);assert.equal((await prospectPage(x.scope,page)).total,12);
  assert.equal((await all(x.scope,'SELECT * FROM discovery_cycles')).length,1);assert.ok((await one<any>(x.scope,'SELECT completed_at FROM discovery_cycles'))!.completed_at);
  await run(x.scope,"UPDATE discovery_cycles SET completed_at=?",new Date(Date.now()-7*86400000).toISOString());assert.equal((await startDiscovery(x.scope,await settings(x.scope))).state,'daily_target');
  await run(x.scope,'UPDATE qualified_prospects SET admitted_at=?',new Date(Date.now()-86400000).toISOString());assert.equal(await qualifiedToday(x.scope),0);assert.equal((await discoveryProgress(x.scope,await settings(x.scope))).qualified,12);assert.equal((await startDiscovery(x.scope,await settings(x.scope))).state,'queued');
 }finally{x.close();}
});

test('a paused workspace cannot create replacement searches or incur provider work',async()=>{
 const x=await setup({prospectingPaused:true,discoveryPaused:true}),original=globalThis.fetch;let calls=0;globalThis.fetch=(async()=>{calls++;throw Error('No live provider allowed');}) as typeof fetch;
 try{await tick(x.scope);assert.equal((await startDiscovery(x.scope,await settings(x.scope))).state,'paused');assert.equal((await all(x.scope,'SELECT * FROM discovery_cycles')).length,0);assert.equal(calls,0);}finally{globalThis.fetch=original;x.close();}
});

test('an active campaign replaces four rejected candidates with twelve distinct fully drafted prospects without sending',async()=>{
 const x=await setup(),original=globalThis.fetch,ai=mockOpenAI();let batch=0;
 const address=(company:string)=>'team@'+company.toLowerCase().replace(/\s/g,'')+'.example.org';
 globalThis.fetch=(async(url:any,init:any)=>{
  const request=JSON.parse(init.body),input=JSON.parse(request.input),response=await ai.fetcher(url,init),data:any=await response.json(),last=data.output.at(-1).content[0],stage=request.text?.format.name?.replace('relay_','')||'';
  if(request.tools){
   if(input.campaign){batch++;last.text+='\nDirectory profiles: '+Array.from({length:4},(_,i)=>batch===1?'Rejected '+i:'Qualified '+((batch-2)*4+i)).join(', ');}
   const company=input.company||input.business?.company;
   if(company)last.text=last.text.replaceAll('buyer@pumps.example.com',address(company));
  }else{
   const out=JSON.parse(last.text);
   if(stage==='discover_extract'){const template=out.candidates[0];out.candidates=Array.from({length:4},(_,i)=>{const company=batch===1?'Rejected '+i:'Qualified '+((batch-2)*4+i);return {...template,company,website:'https://'+address(company).split('@')[1]};});}
   if(stage.startsWith('contact_')){const email=input.report.match(/team@[a-z0-9.]+\.example\.org/)?.[0];if(email){out.email=email;out.excerpt='For pump enquiries email '+email;}}
   if(stage==='solution_design'&&input.business.startsWith('Rejected')){out.qualified=false;out.qualificationReason='Original source did not establish the approved workflow';}
   last.text=JSON.stringify(out);
  }
  return Response.json(data);
 }) as typeof fetch;
 try{
  for(let i=0;i<180;i++){await tick(x.scope);if(await qualifiedToday(x.scope)===12)break;}
  assert.equal(await qualifiedToday(x.scope),12);const result:any=await prospectPage(x.scope,page);assert.equal(result.total,12);assert.equal(new Set(result.rows.map((l:any)=>l.email)).size,12);assert.equal(result.counts.attention,0);
  assert.equal((await all(x.scope,"SELECT * FROM leads WHERE status='not_qualified'")).length,4);assert.equal((await all(x.scope,'SELECT * FROM drafts')).length,12);
  assert.equal((await all(x.scope,'SELECT * FROM discovery_batches')).length,4);assert.equal((await all(x.scope,'SELECT * FROM discovery_cycles')).length,1);
  assert.equal((await all(x.scope,'SELECT * FROM research_claims')).length,16);assert.equal((await all(x.scope,'SELECT * FROM messages')).length,0);
  assert.equal((await all(x.env,'SELECT * FROM leads')).length,0);assert.equal((await startDiscovery(x.scope,await settings(x.scope))).state,'cooldown');
 }finally{globalThis.fetch=original;x.close();}
});
