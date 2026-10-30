import type {Env} from './types';
import {one,run,audit,settings} from './db';
export class OutreachPaused extends Error {constructor(){super('Outreach is paused. Use Resume outreach at the top before starting research or sending.');}}
export async function outreachPaused(env:Env){return (await one<{paused:number} >({...env,DB:env.GLOBAL_DB||env.DB},"SELECT json_extract(data,'$.outreachPaused') paused FROM settings WHERE id=1"))?.paused===1;}
export async function assertOutreachRunning(env:Env){if(await outreachPaused(env))throw new OutreachPaused();}
export async function controlOutreach(env:Env,input:any){
 if(typeof input.paused!=='boolean')throw new Error('Choose whether outreach is paused');
 const root={...env,DB:env.GLOBAL_DB||env.DB};
 await run(root,'INSERT OR IGNORE INTO settings(id,data) VALUES(1,?)',JSON.stringify(await settings(root)));
 await run(root,"UPDATE settings SET data=json_set(data,'$.outreachPaused',json(?),'$.discoveryIntervalDays',6) WHERE id=1",JSON.stringify(input.paused));
 await audit(root,input.paused?'outreach_paused':'outreach_resumed',null,'Owner changed the program pause; discovery settings and email approvals retained');
 return {ok:true,paused:input.paused,message:input.paused?'Outreach paused. No paid research or sending.':'Outreach resumed. Each workspace keeps its discovery setting and six-day search interval.'};
}
