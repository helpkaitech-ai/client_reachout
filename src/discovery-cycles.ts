import type {Env,Settings} from './types';
import {one,run,uid,now,day} from './db';
import {backfillAdmissions,qualifiedToday,readyDraftSql} from './qualified-prospects';

export async function qualifiedInCycle(env:Env,id:string){
 return (await one<{n:number}>(env,`SELECT COUNT(DISTINCT q.lead_id) n FROM qualified_prospects q JOIN drafts d ON d.id=q.draft_id JOIN leads l ON l.id=q.lead_id JOIN discovery_candidates c ON c.lead_id=q.lead_id JOIN discovery_cycle_batches b ON b.batch_id=c.batch_id WHERE b.cycle_id=? AND ${readyDraftSql(true)}`,id))?.n||0;
}
export async function discoveryProgress(env:Env,s:Settings){
 const cycle=await one<any>(env,'SELECT * FROM discovery_cycles WHERE product_revision=? ORDER BY created_at DESC LIMIT 1',env.PRODUCT_REVISION||0);
 return {qualified:cycle?await qualifiedInCycle(env,cycle.id):0,target:Math.min(s.dailyLeadLimit,s.dailyNewLimit),state:cycle?.completed_at?'complete':cycle?'researching':'not_started'};
}

export async function prepareDiscoveryCycle(env:Env,s:Settings){
 await backfillAdmissions(env);
 const revision=env.PRODUCT_REVISION||0,target=Math.min(s.dailyLeadLimit,s.dailyNewLimit);
 let cycle=await one<any>(env,'SELECT * FROM discovery_cycles WHERE product_revision=? ORDER BY created_at DESC LIMIT 1',revision);
 if(cycle&&!cycle.completed_at){
  const qualified=await qualifiedInCycle(env,cycle.id);
  if(qualified>=target){await run(env,'UPDATE discovery_cycles SET completed_at=? WHERE id=?',now(),cycle.id);cycle.completed_at=now();}
 }
 if(cycle?.completed_at&&Date.now()-Date.parse(cycle.completed_at)<s.discoveryIntervalDays*86400000)return {state:'cooldown' as const};
 if(await qualifiedToday(env)>=target)return {state:'daily_target' as const};
 const attempts=(await one<{n:number}>(env,'SELECT COUNT(*) n FROM research_claims WHERE day=?',day()))?.n||0;
 if(attempts>=s.dailyResearchLimit)return {state:'research_limit' as const};
 const backlog=(await one<{n:number}>(env,"SELECT COUNT(*) n FROM leads l WHERE l.status IN ('new','researched','held') AND NOT EXISTS(SELECT 1 FROM drafts d WHERE d.lead_id=l.id) AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.lead_id=l.id AND j.state IN ('failed','uncertain','paused_provider'))"))?.n||0;
 if(backlog)return {state:'researching' as const};
 const searches=(await one<{n:number}>(env,'SELECT COUNT(*) n FROM discovery_batches WHERE created_at>=?',day()+'T00:00:00.000Z'))?.n||0;
 // Also bound zero-result searches, which consume credits but no research slots.
 const searchLimit=Math.max(1,Math.ceil(s.dailyResearchLimit/Math.min(10,s.discoveryResults))*2);
 if(searches>=searchLimit)return {state:'search_limit' as const};
 if(!cycle||cycle.completed_at){
  const previous=await one<any>(env,'SELECT b.id,b.created_at,c.cycle_id FROM discovery_batches b LEFT JOIN discovery_cycle_batches c ON c.batch_id=b.id ORDER BY b.created_at DESC LIMIT 1');
  cycle={id:uid(),created_at:!cycle&&previous&&!previous.cycle_id?previous.created_at:now(),target};
  await run(env,'INSERT INTO discovery_cycles(id,created_at,product_revision,target) VALUES(?,?,?,?)',cycle.id,cycle.created_at,revision,target);
  if(previous&&!previous.cycle_id)await run(env,'INSERT OR IGNORE INTO discovery_cycle_batches(batch_id,cycle_id) VALUES(?,?)',previous.id,cycle.id);
 }
 return {state:'ready' as const,cycleId:cycle.id,capacity:Math.min(10,s.discoveryResults,s.dailyResearchLimit-attempts)};
}
