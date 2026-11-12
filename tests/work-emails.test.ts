import {test} from 'node:test';
import assert from 'node:assert/strict';
import {verifiedMailbox,verifiedWorkContact,workAddress} from '../src/work-email-policy';
import {actorDataset,enrichWorkEmails,professionalEmailRecords} from '../src/work-emails';
import {publicContactReady,readyDraftSql} from '../src/qualified-prospects';
import {database,testSettings,readyLead,readyDraft} from './helpers';
import {one,run,now} from '../src/db';
import {StageYield} from '../src/ai';
import {UncertainProviderError} from '../src/providers';
const check={email:'alex@example.org',status:'good',technical_status:'valid',reason:'ok',free:false,role:false,disposable:false,catch_all:false,mailInfrastructureFound:true};
const contact=()=>({email:check.email,status:'provider_verified',identityConfirmed:true,evidenceType:'provider_verification',provider:'apify/thirdwatch-email-verifier',verification:check,companyDomain:'example.org',profileUrl:'https://www.linkedin.com/in/alex-example',enrichmentRunId:'enrich123',verificationRunId:'verify123',observedAt:now()});
test('work-email policy rejects guessed, personal, role, stale, catch-all and unverifiable contacts',()=>{
 assert.equal(verifiedWorkContact(contact(),check.email,'https://example.org'),true);
 for(const change of [{status:'risky'},{technical_status:'unknown'},{reason:'smtp_timeout'},{free:true},{role:true},{disposable:true},{catch_all:true},{mailInfrastructureFound:false}])assert.equal(verifiedMailbox({...check,...change}),false);
 for(const change of [{verification:{...check,catch_all:true}},{companyDomain:'other.org'},{profileUrl:'https://linkedin.com.evil.test/in/alex'},{observedAt:'2020-01-01'},{verificationRunId:''},{identityConfirmed:false}])assert.equal(verifiedWorkContact({...contact(),...change},check.email,'https://example.org'),false);
 for(const [email,site] of [['alex@gmail.com','https://gmail.com'],['support@example.org','https://example.org'],['alex@other.org','https://example.org']])assert.equal(workAddress(email,site),null);
});
test('qualified SQL and contact gate admit verified work email, reject damaged proof',async()=>{
 const x=database();try{
  const lead=await readyLead(x.env,{email:check.email,website:'https://example.org'});await readyDraft(x.env,lead);
  for(const c of [contact(),{...contact(),verification:{...check,catch_all:true}},{...contact(),verificationRunId:''},{...contact(),observedAt:'2020-01-01'}]){
   await run(x.env,"UPDATE leads SET dossier=?,contact_status='provider_verified',contact_evidence=? WHERE id=?",JSON.stringify({qualified:true}),JSON.stringify(c),lead.id);
   const l=await one<any>(x.env,'SELECT * FROM leads WHERE id=?',lead.id),count=await one<any>(x.env,`SELECT COUNT(*) n FROM leads l JOIN drafts d ON d.lead_id=l.id WHERE ${readyDraftSql(true)}`);
   assert.equal(count.n,publicContactReady(l)?1:0);
  }
 }finally{x.close();}
});
test('enrichment is opt-in and actor submissions are checkpointed, metered, and never replayed',async()=>{
 const x=database(),old=globalThis.fetch;let posts=0,reads=0;x.env.APIFY_TOKEN='fixture';
 globalThis.fetch=async(url,init)=>{if(init?.method==='POST'){posts++;return Response.json({data:{id:'run123'}});}reads++;if(String(url).includes('actor-runs/'))return Response.json({data:{id:'run123',status:'SUCCEEDED',defaultDatasetId:'dataset123',usageTotalUsd:0.05}});return Response.json([check]);};
 try{
  assert.deepEqual(await enrichWorkEmails(x.env,testSettings,'off',{jobId:'off',paidCalls:0},{},[]),[]);assert.equal(posts+reads,0);
  await assert.rejects(actorDataset(x.env,testSettings,'key','thirdwatch~email-verifier','2.0.12',{emails:[check.email]}),StageYield);
  assert.equal((await actorDataset(x.env,testSettings,'key','thirdwatch~email-verifier','2.0.12',{})).items?.length,1);
  await actorDataset(x.env,testSettings,'key','thirdwatch~email-verifier','2.0.12',{});assert.equal(posts,1);assert.equal(reads,2);
  assert.equal((await one<any>(x.env,"SELECT actual FROM expenses WHERE reference='key'")).actual,0.05);
  await run(x.env,'INSERT INTO pipeline_results VALUES(?,?,?)','uncertain',JSON.stringify({state:'submitting',expenseId:'e'}),now());await assert.rejects(actorDataset(x.env,testSettings,'uncertain','a','1',{}),UncertainProviderError);assert.equal(posts,1);
 }finally{globalThis.fetch=old;x.close();}
});

 test('enrichment retains only company-matched work addresses, discarding private contacts and extra profile fields',()=>{
  const url='https://www.linkedin.com/in/alex-example';
  assert.deepEqual(professionalEmailRecords([{linkedinUrl:url,email:'alex@gmail.com',emails:[{email:'alex@example.org'},'alex@former-employer.org'],education:['private'],phone:'private'}],[{profileUrl:url,website:'https://example.org'}]),[{linkedinUrl:url,emails:[{email:'alex@example.org'}]}]);
 });
