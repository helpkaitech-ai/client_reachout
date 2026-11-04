import type {Env,Settings} from './types';
import {one,run,uid,now,day} from './db';
import {backfillAdmissions,qualifiedToday,readyDraftSql} from './qualified-prospects';

export async function qualifiedInCycle(env:Env,id:string){
 return (await one<{n:number}>(env,`SELECT COUNT(DISTINCT lower(l.email)) n FROM qualified_prospects q JOIN drafts d ON d.id=q.draft_id JOIN leads l ON l.id=q.lead_id JOIN discovery_candidates c ON c.lead_id=q.lead_id JOIN discovery_cycle_batches b ON b.batch_id=c.batch_id WHERE b.cycle_id=? AND ${readyDraftSql(!!env.PRODUCT_ID)}`,id))?.n||0;
}
async function currentCycle(env:Env){
 return one<any>(env,`SELECT * FROM discovery_cycles WHERE product_revision=? AND created_at>=?
 AND EXISTS(SELECT 1 FROM discovery_cycle_batches cb JOIN discovery_batches b ON b.id=cb.batch_id JOIN jobs j ON j.id=b.job_id WHERE cb.cycle_id=discovery_cycles.id AND json_extract(j.payload,'$.manual')=1)
 ORDER BY created_at DESC,rowid DESC LIMIT 1`,env.PRODUCT_REVISION||0,day()+'T00:00:00.000Z');
}
export async function cycleAllowance(env:Env,s:Settings){
 const attempts=(await one<{n:number}>(env,'SELECT COUNT(*) n FROM research_claims WHERE day=?',day()))?.n||0;
 const searches=(await one<{n:number}>(env,'SELECT COUNT(*) n FROM discovery_batches WHERE created_at>=?',day()+'T00:00:00.000Z'))?.n||0;
 const searchLimit=Math.max(6,Math.ceil(s.dailyResearchLimit/Math.min(10,s.discoveryResults))*3);
 return {attempts,searches,searchLimit};
}
export async function discoveryProgress(env:Env,s:Settings){
 const cycle=await currentCycle(env),qualified=await qualifiedToday(env),allowance=await cycleAllowance(env,s);
 const counts=await one<{rejected:number;candidates:number}>(env,"SELECT COUNT(*) candidates,coalesce(SUM(status='not_qualified'),0) rejected FROM leads WHERE created_at>=?",day()+'T00:00:00.000Z');
 const rejected=await one<{candidates:number;contact:number;fit:number;evidence:number}>(env,"SELECT COUNT(*) candidates,coalesce(SUM(outcome='no_public_email'),0) contact,coalesce(SUM(outcome='not_a_fit'),0) fit,coalesce(SUM(outcome='needs_review'),0) evidence FROM discovery_candidates WHERE created_at>=?",day()+'T00:00:00.000Z');
 const blocked=await one<{state:string;error:string}>(env,"SELECT state,error FROM jobs WHERE state IN ('paused','paused_provider','failed','uncertain') AND created_at>=? ORDER BY CASE state WHEN 'paused_provider' THEN 0 WHEN 'uncertain' THEN 1 WHEN 'paused' THEN 2 ELSE 3 END,updated_at DESC LIMIT 1",day()+'T00:00:00.000Z');
 const pending=env.PRODUCT_ID&&!env.PRODUCT_APPROVED?await one<{value:string}>(env,"SELECT value FROM integration_state WHERE key='manual_search_request'"):null;
 const profiling=!!pending&&JSON.parse(pending.value).day===day();
 const state=qualified>=s.dailyLeadLimit?'complete':blocked?.state==='paused_provider'?'provider_blocked':blocked?.state==='paused'?'budget_paused':profiling&&blocked?'profile_failed':profiling?'profiling':!cycle||cycle.completed_at?'not_started':allowance.attempts>=s.dailyResearchLimit?'research_limit':allowance.searches>=allowance.searchLimit?'search_limit':'researching';
 const reason=state==='research_limit'?`Used ${allowance.attempts} of ${s.dailyResearchLimit} candidate research attempts. Increase the research allowance to keep replacing rejected candidates.`:state==='search_limit'?`Stopped after ${allowance.searchLimit} searches today without reaching the qualified target. Review targeting or locations before another search.`:['provider_blocked','budget_paused','profile_failed'].includes(state)?blocked?.error:state==='profiling'?'Generating and applying your product profile. Your requested search will continue automatically when it is ready.':state==='complete'?'Today’s qualified prospect target is complete.':state==='not_started'?'Click Find prospects to start today’s search. No searches run on a schedule.':'Searching and researching replacements until the qualified target or a displayed limit is reached.';
 return {qualified,target:s.dailyLeadLimit,state,reason,...allowance,candidates:rejected?.candidates||counts?.candidates||0,rejected:(counts?.rejected||0)+(rejected?.contact||0)+(rejected?.fit||0)+(rejected?.evidence||0),contactRejected:rejected?.contact||0,fitRejected:rejected?.fit||0,evidenceRejected:rejected?.evidence||0};
}
export async function manualCampaignPending(env:Env,s:Settings){
 const cycle=await currentCycle(env);if(!cycle||cycle.completed_at)return false;
 if(await qualifiedToday(env)>=s.dailyLeadLimit){await run(env,'UPDATE discovery_cycles SET completed_at=? WHERE id=?',now(),cycle.id);return false;}
 const waiting=await one<{n:number}>(env,`SELECT COUNT(*) n FROM leads l WHERE l.status IN ('new','researched','held') AND EXISTS(SELECT 1 FROM discovery_candidates c JOIN discovery_cycle_batches b ON b.batch_id=c.batch_id WHERE c.lead_id=l.id AND b.cycle_id=?) AND NOT EXISTS(SELECT 1 FROM drafts d WHERE d.lead_id=l.id) AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.lead_id=l.id AND j.state IN ('failed','uncertain','paused_provider'))`,cycle.id);
 return !waiting?.n;
}
export async function prepareDiscoveryCycle(env:Env,s:Settings,manual=false,continuation=false){
 await backfillAdmissions(env);
 const target=s.dailyLeadLimit,revision=env.PRODUCT_REVISION||0;
 let cycle=await currentCycle(env);
 if(await qualifiedToday(env)>=target){
  if(cycle&&!cycle.completed_at)await run(env,'UPDATE discovery_cycles SET completed_at=? WHERE id=?',now(),cycle.id);
  return {state:'daily_target' as const};
 }
 // A timer may only advance a campaign explicitly started today. It can never
 // create the next campaign or carry yesterday's request into a new UTC day.
 if(continuation&&(!cycle||cycle.completed_at))return {state:'manual_only' as const};
 if(!manual)return {state:'manual_only' as const};
 const {attempts,searches,searchLimit}=await cycleAllowance(env,s);
 if(attempts>=s.dailyResearchLimit)return {state:'research_limit' as const};
 const backlog=(await one<{n:number}>(env,`SELECT COUNT(*) n FROM leads l WHERE l.status IN ('new','researched','held') AND EXISTS(SELECT 1 FROM discovery_candidates c JOIN discovery_cycle_batches b ON b.batch_id=c.batch_id WHERE c.lead_id=l.id AND b.cycle_id=?) AND NOT EXISTS(SELECT 1 FROM drafts d WHERE d.lead_id=l.id) AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.lead_id=l.id AND j.state IN ('failed','uncertain','paused_provider'))`,cycle?.id||''))?.n||0;
 if(backlog)return {state:'researching' as const};
 if(searches>=searchLimit)return {state:'search_limit' as const};
 if(!cycle||cycle.completed_at){
  cycle={id:uid(),created_at:now(),target};
  await run(env,'INSERT INTO discovery_cycles(id,created_at,product_revision,target) VALUES(?,?,?,?)',cycle.id,cycle.created_at,revision,target);
 }
 return {state:'ready' as const,cycleId:cycle.id,capacity:Math.min(10,s.discoveryResults,s.dailyResearchLimit-attempts)};
}
