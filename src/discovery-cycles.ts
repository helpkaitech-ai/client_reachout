import type {Env,Settings} from './types';
import {one,run,uid,now} from './db';
import {backfillAdmissions,qualifiedInCycle} from './qualified-prospects';
export {qualifiedInCycle} from './qualified-prospects';

export function searchTarget(value:unknown=12){
 if(typeof value!=='number'||!Number.isInteger(value)||value<1||value>1000)throw new Error('Choose 1–1,000 prospects per search');
 return value;
}
export async function currentCycle(env:Env){
 return one<any>(env,`SELECT * FROM discovery_cycles WHERE product_revision=?
 AND EXISTS(SELECT 1 FROM discovery_cycle_batches cb JOIN discovery_batches b ON b.id=cb.batch_id JOIN jobs j ON j.id=b.job_id WHERE cb.cycle_id=discovery_cycles.id AND json_extract(j.payload,'$.manual')=1)
 ORDER BY created_at DESC,rowid DESC LIMIT 1`,env.PRODUCT_REVISION||0);
}
export async function cycleAllowance(env:Env,s:Settings,cycle?:any){
 cycle=cycle||await currentCycle(env);
 const attempts=(await one<{n:number}>(env,`SELECT COUNT(DISTINCT r.lead_id) n FROM research_claims r JOIN discovery_candidates c ON c.lead_id=r.lead_id JOIN discovery_cycle_batches b ON b.batch_id=c.batch_id WHERE b.cycle_id=? AND c.outcome='imported'`,cycle?.id||''))?.n||0;
 const searches=(await one<{n:number}>(env,'SELECT COUNT(*) n FROM discovery_cycle_batches WHERE cycle_id=?',cycle?.id||''))?.n||0;
 const researchLimit=cycle?.research_limit||Math.max(60,(cycle?.target||12)*5),searchLimit=Math.max(6,Math.ceil(researchLimit/Math.min(10,s.discoveryResults))*3);
 return {attempts,searches,searchLimit,researchLimit};
}
export async function discoveryProgress(env:Env,s:Settings){
 const cycle=await currentCycle(env),qualified=cycle?await qualifiedInCycle(env,cycle.id):0,allowance=await cycleAllowance(env,s,cycle);
 const pending=await one<{value:string}>(env,"SELECT value FROM integration_state WHERE key='manual_search_request'");
 const request=pending?JSON.parse(pending.value):null,profiling=!!request&&!!env.PRODUCT_ID&&!env.PRODUCT_APPROVED;
 const rejected=await one<any>(env,`SELECT COUNT(*) candidates,coalesce(SUM(c.outcome='no_public_email'),0) contact,coalesce(SUM(c.outcome='not_a_fit'),0) fit,coalesce(SUM(c.outcome='needs_review'),0) evidence FROM discovery_candidates c JOIN discovery_cycle_batches b ON b.batch_id=c.batch_id WHERE b.cycle_id=?`,cycle?.id||'');
 const state=profiling?'profiling':!cycle?'not_started':qualified>=cycle.target?'complete':allowance.attempts>=allowance.researchLimit?'research_limit':allowance.searches>=allowance.searchLimit?'search_limit':cycle.completed_at?'stopped':'researching';
 const reasons={profiling:'Preparing product profile…',not_started:'',complete:'Search complete.',research_limit:'Research allowance reached. Start a new search to continue.',search_limit:'Search allowance reached. Try another search or location.',stopped:'Search ended.',researching:'Searching…'};
 return {id:cycle?.id,qualified,target:profiling?request.target:cycle?.target||12,state,reason:reasons[state],...allowance,candidates:rejected?.candidates||0,rejected:(rejected?.contact||0)+(rejected?.fit||0)+(rejected?.evidence||0),contactRejected:rejected?.contact||0,fitRejected:rejected?.fit||0,evidenceRejected:rejected?.evidence||0};
}
export async function manualCampaignPending(env:Env,s:Settings){
 const cycle=await currentCycle(env);if(!cycle||cycle.completed_at)return false;
 if(await qualifiedInCycle(env,cycle.id)>=cycle.target){await run(env,'UPDATE discovery_cycles SET completed_at=? WHERE id=?',now(),cycle.id);return false;}
 const waiting=await one<{n:number}>(env,`SELECT COUNT(*) n FROM leads l WHERE l.status IN ('new','researched','held') AND EXISTS(SELECT 1 FROM discovery_candidates c JOIN discovery_cycle_batches b ON b.batch_id=c.batch_id WHERE c.lead_id=l.id AND b.cycle_id=? AND c.outcome='imported') AND NOT EXISTS(SELECT 1 FROM drafts d WHERE d.lead_id=l.id) AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.lead_id=l.id AND j.state IN ('failed','uncertain','paused_provider','paused','cancelled'))`,cycle.id);
 return !waiting?.n;
}
export async function prepareDiscoveryCycle(env:Env,s:Settings,manual=false,continuation=false,requestedTarget=s.dailyLeadLimit){
 await backfillAdmissions(env);
 if(!manual)return {state:'manual_only' as const};
 let cycle=await currentCycle(env);
 if(cycle&&!cycle.completed_at){
  const allowance=await cycleAllowance(env,s,cycle);
  if(await qualifiedInCycle(env,cycle.id)>=cycle.target||allowance.attempts>=allowance.researchLimit||allowance.searches>=allowance.searchLimit){
   await run(env,'UPDATE discovery_cycles SET completed_at=? WHERE id=?',now(),cycle.id);cycle.completed_at=now();
  }
 }
 // Only a user request can create a new search; timers continue its saved target.
 if(continuation&&(!cycle||cycle.completed_at))return {state:'manual_only' as const};
 if(!cycle||cycle.completed_at){
  const target=searchTarget(requestedTarget);cycle={id:uid(),created_at:now(),target,research_limit:Math.max(60,target*5)};
  await run(env,'INSERT INTO discovery_cycles(id,created_at,product_revision,target,research_limit) VALUES(?,?,?,?,?)',cycle.id,cycle.created_at,env.PRODUCT_REVISION||0,target,cycle.research_limit);
 }
 const backlog=(await one<{n:number}>(env,`SELECT COUNT(*) n FROM leads l WHERE l.status IN ('new','researched','held') AND EXISTS(SELECT 1 FROM discovery_candidates c JOIN discovery_cycle_batches b ON b.batch_id=c.batch_id WHERE c.lead_id=l.id AND b.cycle_id=? AND c.outcome='imported') AND NOT EXISTS(SELECT 1 FROM drafts d WHERE d.lead_id=l.id) AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.lead_id=l.id AND j.state IN ('failed','uncertain','paused_provider','paused','cancelled'))`,cycle.id))?.n||0;
 if(backlog)return {state:'researching' as const};
 const {attempts,researchLimit}=await cycleAllowance(env,s,cycle);
 return {state:'ready' as const,cycleId:cycle.id,target:cycle.target,capacity:Math.min(10,s.discoveryResults,cycle.target-await qualifiedInCycle(env,cycle.id),researchLimit-attempts)};
}
