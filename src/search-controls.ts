import type {Env} from './types';
import {acquire,release,one,run,now,settings,audit} from './db';
import {currentCycle,discoveryProgress} from './discovery-cycles';

export async function stopSearch(env:Env,expectedCycle?:string){
 const owner=await acquire(env,'discovery-enqueue',60);if(!owner)throw new Error('Search is starting. Try Stop search again.');
 try{
  const cycle=await currentCycle(env);
  if(expectedCycle&&cycle?.id!==expectedCycle)throw new Error('Search changed. Refresh before stopping it.');
  const pending=await one<any>(env,"SELECT value FROM integration_state WHERE key='manual_search_request'");
  const at=now(),active=`SELECT id FROM discovery_cycles WHERE completed_at IS NULL`;
  await env.DB.batch([
   env.DB.prepare(`UPDATE jobs SET state='cancelled',error='Stopped by owner',next_run_at=NULL,updated_at=? WHERE state IN ('pending','running','paused','paused_provider','uncertain') AND ((kind='discover_search' AND id IN (SELECT b.job_id FROM discovery_batches b JOIN discovery_cycle_batches cb ON cb.batch_id=b.id WHERE cb.cycle_id IN (${active}))) OR (kind='research' AND lead_id IN (SELECT c.lead_id FROM discovery_candidates c JOIN discovery_cycle_batches cb ON cb.batch_id=c.batch_id WHERE cb.cycle_id IN (${active}))) OR (kind='product_analysis' AND ?=1))`).bind(at,pending?1:0),
   env.DB.prepare(`UPDATE discovery_batches SET state='cancelled',error='Stopped by owner',updated_at=? WHERE state IN ('queued','running','budget_paused','paused_provider','uncertain') AND id IN (SELECT batch_id FROM discovery_cycle_batches WHERE cycle_id IN (${active}))`).bind(at),
   env.DB.prepare(`INSERT OR REPLACE INTO integration_state(key,value) SELECT 'stopped-search:'||id,? FROM discovery_cycles WHERE completed_at IS NULL`).bind(at),
   env.DB.prepare('UPDATE discovery_cycles SET completed_at=? WHERE completed_at IS NULL').bind(at),
   env.DB.prepare("DELETE FROM integration_state WHERE key='manual_search_request'")
  ]);
  if(pending&&env.PRODUCT_ID)await run({...env,DB:env.GLOBAL_DB||env.DB},"UPDATE products SET state='draft',error=NULL,updated_at=? WHERE id=? AND state='analyzing'",at,env.PRODUCT_ID);
  await audit(env,'search_stopped',cycle?.id||null,'Owner stopped unfinished search work; completed prospects and email conversations retained');
  return {ok:true,message:'Search stopped. Qualified prospects kept.',campaign:await discoveryProgress(env,await settings(env))};
 }finally{await release(env,'discovery-enqueue',owner);}
}

// Keep a tombstone and conversation history to prevent rediscovery or accidental sends.
export async function deleteProspect(env:Env,id:string){
 const owner=await acquire(env,'dispatch',180);if(!owner)throw new Error('An email is being sent. Try deleting again shortly.');
 try{
  const lead=await one<any>(env,'SELECT * FROM leads WHERE id=?',id);if(!lead)throw new Error('Prospect not found');
  if(await one(env,"SELECT id FROM drafts WHERE lead_id=? AND status IN ('sending','uncertain')",id))throw new Error('Check this email’s delivery before deleting the prospect.');
  await env.DB.batch([
   env.DB.prepare("UPDATE leads SET status='deleted',next_followup_at=NULL,updated_at=? WHERE id=?").bind(now(),id),
   env.DB.prepare("UPDATE drafts SET status='cancelled',approved_hash=NULL,approved_version=NULL,approved_at=NULL,updated_at=? WHERE lead_id=? AND status IN ('pending','approved','failed')").bind(now(),id),
   env.DB.prepare("UPDATE jobs SET state='cancelled',next_run_at=NULL,error='Prospect deleted',updated_at=? WHERE lead_id=? AND state IN ('pending','running','paused','paused_provider','uncertain')").bind(now(),id)
  ]);
  await audit(env,'prospect_deleted',id,'Removed from workspace lists and cancelled pending work; history retained');
  return {ok:true,message:'Prospect deleted'};
 }finally{await release(env,'dispatch',owner);}
}
