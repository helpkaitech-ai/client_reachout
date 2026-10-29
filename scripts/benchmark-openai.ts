import fs from 'node:fs';
import {database} from '../tests/helpers';
import {readEnv} from './env.mjs';
import {all,one,run,enqueue,now} from '../src/db';
import {importLead,startDiscovery} from '../src/discovery';
import {processJob} from '../src/engine';
import {defaults,type Job} from '../src/types';

// Isolated, durable test DB. No Gmail/notification credentials are loaded.
// The operator must reserve $2 in the production ledger before executing this.
if(!process.argv.includes('--reservation-confirmed'))throw Error('Production benchmark reservation required');
const {env,close}=database('artifacts/openai-benchmark.sqlite');
const e=readEnv();env.OPENAI_API_KEY=e.OPENAI_API_KEY;env.OPENAI_RESEARCH_MODEL=e.OPENAI_RESEARCH_MODEL;env.OPENAI_DRAFT_MODEL=e.OPENAI_DRAFT_MODEL;
env.ENABLE_SENDING='false';env.ENABLE_NOTIFICATIONS='false';
await run(env,'INSERT OR IGNORE INTO settings(id,data) VALUES(1,?)',JSON.stringify({...defaults,openaiBudget:2,discoveryResults:4}));
const config=await one<any>(env,'SELECT data FROM settings');const settings=JSON.parse(config.data);
const source=fs.existsSync('artifacts/openai-cutover-before.json')?JSON.parse(fs.readFileSync('artifacts/openai-cutover-before.json','utf8')):JSON.parse(fs.readFileSync('artifacts/before-pilot-refresh.json','utf8'));
if(!(await one(env,'SELECT id FROM jobs LIMIT 1'))){
 const examples=source.drafts.filter((x:any)=>x.kind==='initial'&&!x.quality_hold).slice(0,6);
 for(const [i,d] of examples.entries()){
  const prior=source.leads?.find((l:any)=>l.id===d.lead_id),evidence=JSON.parse(d.evidence||'[]');
  const website=prior?.website||evidence.find((v:any)=>v.url)?.url;if(!website)continue;
  const id=await importLead(env,{company:d.company||prior?.company,website,email:null,country:prior?.country||d.country,city:prior?.city||'',industry:prior?.industry||d.industry,timezone:prior?.timezone||'UTC'});
  if(id)await enqueue(env,'research',id,{},'benchmark-business-'+i);
 }
 await startDiscovery(env,settings,{query:'independent commercial maintenance companies',location:'Manchester, UK',country:'GB',timezone:'Europe/London',enabled:true},'benchmark-scope-uk');
 await startDiscovery(env,settings,{query:'independent corporate training providers',location:'Bengaluru, India',country:'IN',timezone:'Asia/Kolkata',enabled:true},'benchmark-scope-in');
}
function save(report:any){fs.writeFileSync('artifacts/openai-benchmark-results.json',JSON.stringify(report,null,2));}
try{
 // Finish one business before the next; stage cache survives process interruption.
 for(const jobId of ['discovery:benchmark-scope-uk','discovery:benchmark-scope-in',...Array.from({length:6},(_,i)=>'benchmark-business-'+i)]){
  for(let step=0;step<12;step++){
   const job=await one<Job&{error?:string}>(env,'SELECT * FROM jobs WHERE id=?',jobId);if(!job||job.state!=='pending')break;
   await processJob(env,job);
   const state=await one<any>(env,'SELECT state,error FROM jobs WHERE id=?',jobId);
   const cost=await one<any>(env,"SELECT COALESCE(SUM(CASE WHEN state='settled' THEN actual ELSE reserved END),0) committed FROM expenses");
   console.log(JSON.stringify({job:jobId,step:step+1,state:state.state,error:state.error,committedUsd:cost.committed}));
   save({at:now(),inProgress:true,committedUsd:cost.committed});
   if(state.state!=='pending')break;
  }
 }
 const expenses=await all<any>(env,'SELECT * FROM expenses'),committed=expenses.reduce((n,e)=>n+(e.state==='settled'?e.actual:e.reserved),0);
 const report={at:now(),capUsd:2,committedUsd:committed,estimatedActualUsd:expenses.filter(e=>e.state==='settled').reduce((n,e)=>n+e.actual,0),unknownUsage:expenses.some(e=>e.state!=='settled'),sendingEnabled:false,sourceBusinessCount:6,jobs:await all(env,'SELECT id,kind,state,error FROM jobs'),searches:await all(env,'SELECT * FROM discovery_batches'),candidates:await all(env,'SELECT outcome,data FROM discovery_candidates'),businesses:await all(env,'SELECT id,company,email,contact_status,contact_evidence,dossier,solution FROM leads'),drafts:await all(env,'SELECT lead_id,subject,body,quality_hold,evidence,free_offer,status FROM drafts'),attempts:await all(env,'SELECT job_id,stage,state,request_id,response_id,error FROM ai_attempts'),outboundMessages:(await all(env,'SELECT * FROM messages')).length};
 save(report);if(committed>2+1e-9||report.outboundMessages)throw Error('Benchmark boundary violated');
 console.log(JSON.stringify({complete:true,committedUsd:committed,drafts:report.drafts.length,qualified:report.drafts.filter((d:any)=>!d.quality_hold).length,searches:report.searches.length}));
}finally{close();}
