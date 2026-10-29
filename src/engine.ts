import type {Env,Job,Lead} from './types';
import {acquire,all,audit,BudgetPaused,claimResearchBusiness,day,enqueue,now,one,release,run,settings} from './db';
import {startDiscovery,runDiscovery,discoveryPause} from './discovery';
import {draftLead} from './research';
import {notifyDigest,sendApproved,syncInbox} from './mail';
import {UncertainProviderError,ProviderError} from './providers';
import {StageYield,type Workflow} from './ai';
import {requireProductReady,productList,scopeProduct,advanceProductAnalysis} from './products';

export async function scheduleResearch(env:Env){
 const at=now(),prefix=env.PRODUCT_ID?'initial-product:'+env.PRODUCT_REVISION+':':'initial-ai:';
 await run(env,`INSERT OR IGNORE INTO jobs(id,kind,lead_id,payload,created_at,updated_at)
 SELECT ?||id,'research',id,'{}',?,? FROM leads WHERE status IN ('new','researched','held')
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
 const claim=await run(env,"UPDATE jobs SET state='running',attempts=attempts+1,error=NULL,updated_at=? WHERE id=? AND state='pending'",now(),job.id);if(!claim.meta.changes)return;
 const payload=JSON.parse(job.payload),w:Workflow={jobId:job.id,paidCalls:0,retryVersion:payload.retryVersion||0,priority:['reply','followup'].includes(job.kind),maxCost:payload.maxCost};
 try{
  requireProductReady(env);
  const s=await settings(env);let result;
  if(job.kind==='discover_search'){
   const resumeAt=discoveryPause(s);if(resumeAt){await run(env,"UPDATE jobs SET state='paused',error='New prospect searches temporarily paused; existing business research continues',next_run_at=?,updated_at=? WHERE id=? AND state='running'",resumeAt,now(),job.id);return;}
   result=await runDiscovery(env,s,job,w);
  }
  else if(['research','rewrite','followup','reply'].includes(job.kind)){
   const lead=await one<Lead>(env,'SELECT * FROM leads WHERE id=?',job.lead_id);if(!lead)throw new Error('Prospect not found');
   if(['suppressed','closed'].includes(lead.status))throw new Error('Prospect is not active');
   if(job.kind==='research'&&!await claimResearchBusiness(env,lead.id,s.dailyResearchLimit)){
    await run(env,"UPDATE jobs SET state='paused',error='Daily business research allowance reached',next_run_at=?,updated_at=? WHERE id=?",new Date(Date.parse(day()+'T00:00:00Z')+86400000).toISOString(),now(),job.id);return;
   }
   await draftLead(env,s,lead,job.kind==='reply'?'reply':job.kind==='followup'?'followup':'initial',payload.inboundId,job.kind==='rewrite'?{id:payload.draftId,version:payload.version}:undefined,w);
  }else throw new Error('Retired or unsupported task type');
  await run(env,"UPDATE jobs SET state='complete',error=NULL,next_run_at=NULL,updated_at=? WHERE id=? AND state='running'",now(),job.id);return result;
 }catch(error){
  if(error instanceof StageYield){await run(env,"UPDATE jobs SET state='pending',updated_at=? WHERE id=? AND state='running'",now(),job.id);return {state:'pending'};}
  const message=error instanceof Error?error.message:'Task failed';
  const budget=error instanceof BudgetPaused,providerQuota=error instanceof ProviderError&&error.status===429;
  const state=budget?'paused':providerQuota?'paused_provider':error instanceof UncertainProviderError?'uncertain':'failed';
  await run(env,"UPDATE jobs SET state=?,error=?,next_run_at=?,updated_at=? WHERE id=? AND state='running'",state,message.slice(0,400),budget?new Date(Date.now()+60000).toISOString():null,now(),job.id);
  if(job.kind==='discover_search')await run(env,'UPDATE discovery_batches SET state=?,error=?,updated_at=? WHERE job_id=?',budget?'budget_paused':state,message.slice(0,400),now(),job.id);
  if(!budget)await audit(env,'job_'+state,job.id,message);
 }
}
export async function processDiscovery(env:Env){const job=await one<Job>(env,"SELECT * FROM jobs WHERE kind='discover_search' AND state='pending' ORDER BY created_at,id LIMIT 1");return job?processJob(env,job):undefined;}
export async function processAvailableJobs(env:Env){
 if(!env.OPENAI_API_KEY)return;
 // One paid stage per cycle stays within Workers Free's 50 D1 query limit.
 // Bounded discovery imports also persist only three candidates per invocation.
 const job=await one<Job>(env,`SELECT * FROM jobs WHERE state='pending' AND kind IN ('reply','followup','discover_search','rewrite','research') ORDER BY CASE kind WHEN 'reply' THEN 0 WHEN 'followup' THEN 1 WHEN 'discover_search' THEN 2 ELSE 3 END,CASE WHEN EXISTS(SELECT 1 FROM ai_attempts a WHERE a.job_id=jobs.id) THEN 0 ELSE 1 END,created_at,id LIMIT 1`);
 if(job)await processJob(env,job);
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
  if(env.ENABLE_AUTOMATION==='true'&&s.researchAutomation!==false){
   const backlog=await researchBacklog(env);
   if(backlog<s.dailyNewLimit*3&&env.OPENAI_API_KEY)await startDiscovery(env,s);
   // Legacy reconciliation is an explicit cutover operation, not a repeated
   // scan of every old expense on each cron invocation.
   await scheduleResearch(env);
   await run(env,`INSERT OR IGNORE INTO jobs(id,kind,lead_id,payload,created_at,updated_at)
    SELECT 'followup:'||id||':'||followup_count,'followup',id,'{}',?,? FROM leads
    WHERE next_followup_at IS NOT NULL AND last_inbound_at IS NULL AND status='contacted' AND followup_count<?
    AND NOT EXISTS(SELECT 1 FROM drafts WHERE lead_id=leads.id AND status IN ('pending','approved','sending','uncertain'))`,now(),now(),Math.min(3,s.followupDays.length));
  }
  const dispatchWork={processed:0};
  if(inboxOk)await sendApproved(env,s,undefined,dispatchWork);
  if(s.researchAutomation!==false&&inboxWork.processed===0&&dispatchWork.processed===0)await processAvailableJobs(env);
  if(new Date().getUTCHours()>=3)await notifyDigest(env,s);
  await run(env,'DELETE FROM sessions WHERE expires_at<?',now());await run(env,'DELETE FROM auth_attempts WHERE reset_at<?',now());
 }catch(error){await audit(env,'engine_error',null,error instanceof Error?error.message:'Engine failed');}
 finally{await release(env,'scheduler',owner);}
}
export async function tickWorkspaces(env:Env){
 await tick(env);
 // Isolated leases and ledgers allow all approved products to progress fairly.
 const products=await productList(env);
 await Promise.all(products.filter(p=>p.enabled).map(async p=>{
  try{if(p.state==='analyzing')await advanceProductAnalysis(env,p);else if(p.state==='approved'&&p.approved_revision===p.revision)await tick(await scopeProduct(env,p));}
  catch(e){await audit(env,'product_cycle_failed',p.id,e instanceof Error?e.message:'Product cycle failed');}
 }));
}
