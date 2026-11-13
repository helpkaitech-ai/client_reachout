import {WorkCancelled} from './job-control';
import type {Env,Job,Lead,Settings} from './types';
import {acquire,all,audit,BudgetPaused,claimResearchBusiness,day,enqueue,now,one,release,run,settings} from './db';
import {startDiscovery,runDiscovery} from './discovery';
import {draftLead} from './research';
import {notifyDigest,sendApproved,syncInbox} from './mail';
import {UncertainProviderError,ProviderError} from './providers';
import {StageYield,type Workflow} from './ai';
import {requireProductReady,productList,scopeProduct,advanceProductAnalysis,continueProductDiscovery} from './products';
import {providerBlock,OpenAICreditBlocked,releaseUnspentResearchClaim} from './provider-control';
import {admissionAvailable,cycleForLead} from './qualified-prospects';
import {manualCampaignPending,cycleAllowance} from './discovery-cycles';

export async function scheduleResearch(env:Env,manualOnly=false){
 const at=now(),prefix=env.PRODUCT_ID?'initial-product:'+env.PRODUCT_REVISION+':':'initial-ai:';
 const manual=`EXISTS(SELECT 1 FROM discovery_candidates c JOIN discovery_batches b ON b.id=c.batch_id JOIN jobs dj ON dj.id=b.job_id WHERE c.lead_id=leads.id AND json_extract(dj.payload,'$.manual')=1 AND EXISTS(SELECT 1 FROM discovery_cycle_batches cb JOIN discovery_cycles cy ON cy.id=cb.cycle_id WHERE cb.batch_id=b.id AND cy.completed_at IS NULL AND cy.product_revision=${env.PRODUCT_REVISION||0}))`;
 await run(env,`INSERT OR IGNORE INTO jobs(id,kind,lead_id,payload,created_at,updated_at)
 SELECT ?||id,'research',id,CASE WHEN ${manual} THEN json_object('manual',json('true'),'campaignDay','${day()}') ELSE '{}' END,?,? FROM leads WHERE status IN ('new','researched','held')
 ${manualOnly?'AND '+manual:''}
 AND id NOT IN (SELECT lead_id FROM drafts)
 AND id NOT IN (SELECT lead_id FROM jobs WHERE state IN ('pending','running','uncertain','failed','paused','paused_provider') AND lead_id IS NOT NULL)
 ORDER BY CASE WHEN email IS NOT NULL THEN 0 ELSE 1 END,created_at LIMIT 100`,prefix,at,at);
}
export async function researchBacklog(env:Env){
 return (await one<{n:number}>(env,`SELECT COUNT(*) n FROM leads l WHERE l.status IN ('new','researched','held')
 AND NOT EXISTS(SELECT 1 FROM drafts d WHERE d.lead_id=l.id)
 AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.lead_id=l.id AND j.state IN ('uncertain','failed','paused_provider'))`))?.n||0;
}
export async function recoverUnstartedResearch(env:Env){
 const r=await run(env,`UPDATE jobs SET state='pending',error=NULL,updated_at=? WHERE kind='research' AND state='uncertain'
 AND error='Worker stopped during paid work. Inspect provider before retry.'
 AND EXISTS(SELECT 1 FROM leads l WHERE l.id=jobs.lead_id AND l.status IN ('new','researched','held'))
 AND NOT EXISTS(SELECT 1 FROM drafts d WHERE d.lead_id=jobs.lead_id)
 AND NOT EXISTS(SELECT 1 FROM expenses e WHERE e.reference=jobs.lead_id OR e.reference LIKE jobs.lead_id||':%')
 AND NOT EXISTS(SELECT 1 FROM ai_attempts a WHERE a.job_id=jobs.id)`,now());
 if(r.meta.changes)await audit(env,'unstarted_research_recovered',null,`${r.meta.changes} tasks had no provider history and returned to queue`);
}
export async function processJob(env:Env,job:Job){
 if(await providerBlock(env))return {paused:true};
 const claim=await run(env,"UPDATE jobs SET state='running',attempts=attempts+1,error=NULL,updated_at=? WHERE id=? AND state='pending'",now(),job.id);if(!claim.meta.changes)return;
 const payload=JSON.parse(job.payload);
 const w:Workflow={jobId:job.id,paidCalls:0,retryVersion:payload.retryVersion||0,priority:['reply','followup'].includes(job.kind),maxCost:payload.maxCost};
 try{
  requireProductReady(env);
  const s=await settings(env);let result;
  if(job.kind==='discover_search'){
   if(!payload.manual){await run(env,"UPDATE jobs SET state='cancelled',error='Recurring searches removed',updated_at=? WHERE id=?",now(),job.id);return;}
   result=await runDiscovery(env,s,job,w);
  }
  else if(['research','rewrite','followup','reply'].includes(job.kind)){
   const lead=await one<Lead>(env,'SELECT * FROM leads WHERE id=?',job.lead_id);if(!lead)throw new Error('Prospect not found');
   if(['suppressed','closed','deleted'].includes(lead.status))throw new Error('Prospect is not active');
   if(job.kind==='research'&&!await admissionAvailable(env,s,lead.id)){
    await run(env,"UPDATE jobs SET state='cancelled',error='Search target reached',next_run_at=NULL,updated_at=? WHERE id=?",now(),job.id);return;
   }
   if(job.kind==='research'){
    const cycle=await cycleForLead(env,lead.id),allowance=cycle?await cycleAllowance(env,s,cycle):null;
    if(allowance&&allowance.attempts>=allowance.researchLimit&&!await one(env,'SELECT lead_id FROM research_claims WHERE lead_id=?',lead.id)){
     await run(env,"UPDATE jobs SET state='paused',error='Search research allowance reached',next_run_at=NULL,updated_at=? WHERE id=?",now(),job.id);return;
    }
    await claimResearchBusiness(env,lead.id,Number.MAX_SAFE_INTEGER);
   }
   const kind=job.kind==='reply'?'reply':job.kind==='followup'?'followup':job.kind==='rewrite'&&['followup','reply'].includes(payload.kind)?payload.kind:'initial';
   await draftLead(env,s,lead,kind,payload.inboundId,job.kind==='rewrite'?{id:payload.draftId,version:payload.version}:undefined,w);
  }else throw new Error('Retired or unsupported task type');
  await run(env,"UPDATE jobs SET state='complete',error=NULL,next_run_at=NULL,updated_at=? WHERE id=? AND state='running'",now(),job.id);return result;
 }catch(error){
  if(error instanceof WorkCancelled){await run(env,"UPDATE jobs SET state='cancelled',error=?,updated_at=? WHERE id=? AND state='running'",error.message,now(),job.id);return {state:'cancelled'};}
  if(error instanceof StageYield){await run(env,"UPDATE jobs SET state='pending',updated_at=? WHERE id=? AND state='running'",now(),job.id);return {state:'pending'};}
  const message=error instanceof Error?error.message:'Task failed';
  const budget=error instanceof BudgetPaused,providerQuota=error instanceof OpenAICreditBlocked||error instanceof ProviderError&&error.status===429;
  if(providerQuota&&job.kind==='research'&&job.lead_id)await releaseUnspentResearchClaim(env,job.lead_id);
  const state=budget?'paused':providerQuota?'paused_provider':error instanceof UncertainProviderError?'uncertain':'failed';
  await run(env,"UPDATE jobs SET state=?,error=?,next_run_at=?,updated_at=? WHERE id=? AND state='running'",state,message.slice(0,400),budget?new Date(Date.now()+60000).toISOString():null,now(),job.id);
  if(job.kind==='discover_search')await run(env,"UPDATE discovery_batches SET state=?,error=?,updated_at=? WHERE job_id=? AND state<>'cancelled'",budget?'budget_paused':state,message.slice(0,400),now(),job.id);
  if(!budget)await audit(env,'job_'+state,job.id,message);
 }
}
export async function processDiscovery(env:Env){const job=await one<Job>(env,"SELECT * FROM jobs WHERE kind='discover_search' AND state='pending' ORDER BY created_at,id LIMIT 1");return job?processJob(env,job):undefined;}
export async function processAvailableJobs(env:Env,currentSettings?:Settings,manualOnly=false){
 if(!env.OPENAI_API_KEY)return;
 const s=currentSettings||await settings(env);
 // Each checkpoint invocation makes at most one paid call. The paid deployment
 // may advance up to three checkpoints per cycle; Free retains a one-step default.
 const job=await one<Job>(env,`SELECT * FROM jobs WHERE state='pending' AND kind IN ('reply','followup','discover_search','rewrite','research') AND (kind<>'discover_search' OR json_extract(payload,'$.manual')=1) AND (?=0 OR json_extract(payload,'$.manual')=1 OR kind IN ('reply','followup','rewrite')) ORDER BY CASE kind WHEN 'reply' THEN 0 WHEN 'followup' THEN 1 WHEN 'rewrite' THEN 2 WHEN 'discover_search' THEN 3 ELSE 4 END,CASE WHEN EXISTS(SELECT 1 FROM ai_attempts a WHERE a.job_id=jobs.id) THEN 0 ELSE 1 END,created_at,id LIMIT 1`,manualOnly?1:0);
 if(job){await processJob(env,job);return true;}return false;
}
export async function tick(env:Env){
 const owner=await acquire(env,'scheduler',840);if(!owner)return {busy:true};
 try{
  const s=await settings(env),stale=new Date(Date.now()-15*60000).toISOString();
  await run(env,"UPDATE drafts SET status='uncertain',error='Worker stopped during dispatch. Reconcile with Sent mail.',updated_at=? WHERE status='sending' AND updated_at<?",now(),stale);
  // Completed saved responses can resume; unknown submissions cannot be replayed.
  await run(env,`UPDATE jobs SET state=CASE WHEN EXISTS(SELECT 1 FROM ai_attempts a WHERE a.job_id=jobs.id AND a.state IN ('submitting','uncertain')) THEN 'uncertain' ELSE 'pending' END,error='Interrupted stage; saved provider output retained',updated_at=?
   WHERE state='running' AND updated_at<? AND EXISTS(SELECT 1 FROM ai_attempts a WHERE a.job_id=jobs.id)`,now(),stale);
  await run(env,"UPDATE jobs SET state='uncertain',error='Worker stopped during paid work. Inspect provider before retry.',updated_at=? WHERE state='running' AND updated_at<?",now(),stale);
  await run(env,"UPDATE jobs SET state='pending',next_run_at=NULL WHERE state='paused' AND next_run_at<=?",now());
  const inboxWork={processed:0};
  let inboxOk=false;if(env.GOOGLE_REFRESH_TOKEN){try{inboxOk=await syncInbox(env,inboxWork);}catch{await audit(env,'inbox_sync_failed',null,'Sending paused this cycle because inbox synchronization failed');}}
  // Cron advances only owner-requested campaigns and explicit email work.
  // It never starts a recurring prospect search, regardless of legacy flags.
  await scheduleResearch(env,true);
  if(await manualCampaignPending(env,s))await startDiscovery(env,s,undefined,undefined,true,true);
  if(env.ENABLE_AUTOMATION==='true')await run(env,`INSERT OR IGNORE INTO jobs(id,kind,lead_id,payload,created_at,updated_at)
   SELECT 'followup:'||id||':'||followup_count,'followup',id,'{}',?,? FROM leads
   WHERE next_followup_at IS NOT NULL AND last_inbound_at IS NULL AND status='contacted' AND followup_count<?
   AND NOT EXISTS(SELECT 1 FROM drafts WHERE lead_id=leads.id AND status IN ('pending','approved','sending','uncertain'))`,now(),now(),Math.min(3,s.followupDays.length));
  const dispatchWork={processed:0};
  if(inboxOk)await sendApproved(env,s,undefined,dispatchWork);
  if(inboxWork.processed===0&&dispatchWork.processed===0){
   const stages=Math.min(3,Math.max(1,Math.floor(Number(env.AI_STAGES_PER_CYCLE)||1)));
   for(let step=0;step<stages;step++){
    if(step>0&&(await providerBlock(env)))break;
    if(!await processAvailableJobs(env,s,true))break;
   }
  }
  if(new Date().getUTCHours()>=3)await notifyDigest(env,s);
  // Authentication now lives in AUTH_STORE; do not scan its retired D1 tables
  // on every research cycle. AUTH_STORE handles active session expiration.
 }catch(error){await audit(env,'engine_error',null,error instanceof Error?error.message:'Engine failed');}
 finally{await release(env,'scheduler',owner);}
}
export async function tickWorkspaces(env:Env){
 await tick(env);
 // Isolated leases and ledgers allow all approved products to progress fairly.
 const products=await productList(env);
 await Promise.all(products.filter(p=>p.enabled).map(async p=>{
  try{if(p.state==='analyzing')await advanceProductAnalysis(env,p);else if(p.state==='target_review'){const {approveProduct}=await import('./products');await approveProduct(env,p.id,p.revision);}
   else if(p.state==='approved'&&p.approved_revision===p.revision){await continueProductDiscovery(env,p);await tick(await scopeProduct(env,p));}}
  catch(e){await audit(env,'product_cycle_failed',p.id,e instanceof Error?e.message:'Product cycle failed');}
 }));
}
