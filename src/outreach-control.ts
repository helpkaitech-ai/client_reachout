import type {Env} from './types';
import {one,run,audit,settings} from './db';
export class OutreachPaused extends Error {constructor(){super('Outreach is paused. Use Resume outreach at the top before starting research or sending.');}}
export async function outreachPaused(env:Env){return (await one<{paused:number} >({...env,DB:env.GLOBAL_DB||env.DB},"SELECT json_extract(data,'$.outreachPaused') paused FROM settings WHERE id=1"))?.paused===1;}
export async function assertOutreachRunning(env:Env){if(await outreachPaused(env))throw new OutreachPaused();}
export class ProspectingPaused extends Error {constructor(){super('Prospecting is paused in this workspace. Resume prospects for this product or Existing outreach first.');}}
async function pauseState(env:Env){
 const local=await one<{outreach:number;prospecting:number}>(env,"SELECT json_extract(data,'$.outreachPaused') outreach,json_extract(data,'$.prospectingPaused') prospecting FROM settings WHERE id=1");
 return {outreach:env.GLOBAL_DB?await outreachPaused(env):local?.outreach===1,prospecting:local?.prospecting===1};
}
export async function prospectingPaused(env:Env){const state=await pauseState(env);return state.outreach||state.prospecting;}
export async function assertProspectingRunning(env:Env){const state=await pauseState(env);if(state.outreach)throw new OutreachPaused();if(state.prospecting)throw new ProspectingPaused();}
export async function controlProspecting(env:Env,paused:boolean){
 if(typeof paused!=='boolean')throw new Error('Choose whether prospecting is paused');
 await run(env,'INSERT OR IGNORE INTO settings(id,data) VALUES(1,?)',JSON.stringify(await settings(env)));
 await run(env,"UPDATE settings SET data=json_set(data,'$.prospectingPaused',json(?),'$.discoveryPaused',json(?),'$.discoveryPausedUntil','') WHERE id=1",JSON.stringify(paused),JSON.stringify(paused));
 await audit(env,paused?'prospecting_paused':'prospecting_resumed',env.PRODUCT_ID||null,'Owner changed only this workspace; product configuration and analysis remain available');
 return {ok:true,message:paused?'Prospecting paused in this workspace, including queued research and sending.':'Prospecting resumed in this workspace. Automatic discovery follows the configured workspace interval.'};
}
export async function controlOutreach(env:Env,input:any){
 if(typeof input.paused!=='boolean')throw new Error('Choose whether outreach is paused');
 const root={...env,DB:env.GLOBAL_DB||env.DB};
 await run(root,'INSERT OR IGNORE INTO settings(id,data) VALUES(1,?)',JSON.stringify(await settings(root)));
 await run(root,"UPDATE settings SET data=json_set(data,'$.outreachPaused',json(?)) WHERE id=1",JSON.stringify(input.paused));
 await audit(root,input.paused?'outreach_paused':'outreach_resumed',null,'Owner changed the program pause; discovery settings and email approvals retained');
 return {ok:true,paused:input.paused,message:input.paused?'Relay paused. No paid research or sending.':'Relay active. Product configuration is available; every workspace keeps its own prospecting pause.'};
}
