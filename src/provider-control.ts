import type {Env} from './types';
import {one,run,now,audit} from './db';
export class OpenAICreditBlocked extends Error {constructor(){super('OpenAI credits need attention. Update billing for the deployed key, then confirm in Settings before retrying.');}}
const root=(env:Env)=>({...env,DB:env.GLOBAL_DB||env.DB});
export async function providerBlock(env:Env){const row=await one<{value:string}>(root(env),"SELECT value FROM integration_state WHERE key='openai_credit_block'");return row?JSON.parse(row.value):null;}
export async function assertProviderAvailable(env:Env){if(await providerBlock(env))throw new OpenAICreditBlocked();}
export async function blockProvider(env:Env,code:string){
 if(!['credit_balance_exhausted','insufficient_quota','billing_hard_limit_reached'].includes(code))return;
 await run(root(env),"INSERT INTO integration_state(key,value) VALUES('openai_credit_block',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",JSON.stringify({code,at:now(),message:'The OpenAI billing scope used by the deployed key rejected a request. No further paid work starts until the owner confirms billing is fixed.'}));
}
export async function clearProviderBlock(env:Env,input:any){
 if(input.billingUpdated!==true)throw new Error('Confirm you updated billing for the OpenAI project used by Relay');
 await run(root(env),"DELETE FROM integration_state WHERE key='openai_credit_block'");
 await audit(root(env),'openai_credit_block_cleared',null,'Owner confirmed billing updated; paused workspaces and uncertain tasks remain untouched');
 return {ok:true,message:'Billing stop cleared. Retry stopped tasks deliberately; workspace pauses remain unchanged.'};
}
export async function releaseUnspentResearchClaim(env:Env,leadId:string){
 const day=now().slice(0,10);
 await run(env,`DELETE FROM research_claims WHERE day=? AND lead_id=? AND NOT EXISTS(
 SELECT 1 FROM ai_attempts a JOIN jobs j ON j.id=a.job_id JOIN expenses e ON e.id=a.expense_id
 WHERE j.lead_id=? AND a.created_at>=? AND (e.state<>'settled' OR coalesce(e.actual,0)>0))`,day,leadId,leadId,day+'T00:00:00.000Z');
}
