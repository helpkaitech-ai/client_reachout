import { defaults, type Env, type Settings } from './types';
export const now = () => new Date().toISOString();
export const uid = ():string => crypto.randomUUID();
export const month = () => now().slice(0,7);
export const day = () => now().slice(0,10);
export async function all<T>(env:Env, sql:string, ...args:unknown[]):Promise<T[]> {
 return (await env.DB.prepare(sql).bind(...args).all<T>()).results;
}
export async function one<T>(env:Env, sql:string, ...args:unknown[]):Promise<T|null> {
 return env.DB.prepare(sql).bind(...args).first<T>();
}
export async function run(env:Env, sql:string, ...args:unknown[]) { return env.DB.prepare(sql).bind(...args).run(); }
export async function settings(env:Env):Promise<Settings> {
 const row=await one<{data:string}>(env,'SELECT data FROM settings WHERE id=1');
 const stored=row?JSON.parse(row.data):{};
 const active=Object.fromEntries(Object.keys(defaults).filter(k=>k in stored).map(k=>[k,stored[k]]));
 const result={...defaults,...active,openaiBudget:Math.min(50,Number(active.openaiBudget)||50),discoveryResults:Math.min(10,Number(active.discoveryResults)||10)};
 if(env.PRODUCT_ID)result.outreachPaused=env.OUTREACH_PAUSED===true;
 if(env.PRODUCT_ID){result.dailyResearchLimit=Math.min(20,result.dailyResearchLimit);result.dailyTotalLimit=Math.min(12,result.dailyTotalLimit);result.dailyNewLimit=Math.min(12,result.dailyNewLimit);result.offerContext=env.PRODUCT_BRIEF||result.offerContext;if(!env.PRODUCT_APPROVED)result.researchAutomation=false;if(Date.parse(env.DISCOVERY_PAUSED_UNTIL||'')>Date.parse(result.discoveryPausedUntil||'1970-01-01T00:00:00Z'))result.discoveryPausedUntil=env.DISCOVERY_PAUSED_UNTIL;}
 return result;
}
export async function audit(env:Env,type:string,entity:string|null,detail:string) {
 await run(env,'INSERT INTO events(type,entity_id,detail,created_at) VALUES(?,?,?,?)',type,entity,detail.slice(0,2000),now());
}
export async function acquire(env:Env,name:string,seconds=600):Promise<string|null> {
 const owner=uid(); const at=now();
 const r=await run(env,`INSERT INTO leases(name,owner,expires_at) VALUES(?,?,?)
 ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE leases.expires_at < ?`,
 name,owner,new Date(Date.now()+seconds*1000).toISOString(),at);
 return r.meta.changes ? owner : null;
}
export async function release(env:Env,name:string,owner:string) { await run(env,'DELETE FROM leases WHERE name=? AND owner=?',name,owner); }
export async function reserve(env:Env,provider:string,amount:number,limit:number,reference:string):Promise<string> {
 if(!Number.isFinite(amount)||amount<=0||!Number.isFinite(limit)||limit<0) throw new Error('Invalid budget amount');
 const id=uid();
 const r=await run(env,`INSERT INTO expenses(id,provider,month,reserved,reference,created_at)
 SELECT ?,?,?,?,?,? WHERE ? + COALESCE((SELECT SUM(CASE WHEN state='settled' THEN actual ELSE reserved END)
 FROM expenses WHERE provider=? AND month=?),0) <= ?`,id,provider,month(),amount,reference,now(),amount,provider,month(),limit);
 if(!r.meta.changes) throw new BudgetPaused(`${provider} monthly budget has insufficient unreserved funds`);
 return id;
}
export class BudgetPaused extends Error {}
export async function claimResearchBusiness(env:Env,leadId:string,limit:number) {
 const at=day();
 if(await one(env,'SELECT lead_id FROM research_claims WHERE day=? AND lead_id=?',at,leadId))return true;
 const result=await run(env,`INSERT OR IGNORE INTO research_claims(day,lead_id)
 SELECT ?,? WHERE (SELECT COUNT(*) FROM research_claims WHERE day=?)<?`,at,leadId,at,limit);
 return !!result.meta.changes||!!await one(env,'SELECT lead_id FROM research_claims WHERE day=? AND lead_id=?',at,leadId);
}
export async function settle(env:Env,id:string,actual:number,note='Usage estimate from provider response; invoice is authoritative') {
 if(!Number.isFinite(actual)||actual<0) throw new Error('Invalid provider cost');
 await run(env,"UPDATE expenses SET actual=?,state='settled',note=? WHERE id=?",actual,note,id);
}
export async function uncertainExpense(env:Env,id:string) {
 await run(env,"UPDATE expenses SET state='uncertain',note='Request outcome or billing unknown; full reservation retained. Do not automatically resubmit.' WHERE id=?",id);
}
export async function claimDaily(env:Env,column:'new_slots'|'send_slots'|'research_slots',limit:number) {
 await run(env,'INSERT OR IGNORE INTO daily_usage(day) VALUES(?)',day());
 const r=await run(env,`UPDATE daily_usage SET ${column}=${column}+1 WHERE day=? AND ${column}<?`,day(),limit);
 return !!r.meta.changes;
}
export async function enqueue(env:Env,kind:string,leadId:string|null,payload:unknown={},id=uid()) {
 await run(env,"INSERT OR IGNORE INTO jobs(id,kind,lead_id,payload,created_at,updated_at) VALUES(?,?,?,?,?,?)",id,kind,leadId,JSON.stringify(payload),now(),now());
 return id;
}
