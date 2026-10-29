import type {Env} from './types';
import {all,one,run,now} from './db';
interface AppNotification {id:string;kind:string;product_id:string;workspace_name:string;lead_id:string;draft_id:string|null;title:string;body:string;created_at:string;read_at:string|null}

export async function notifyInApp(env:Env,event:{key:string;kind:string;leadId:string;draftId?:string;title:string;body?:string}){
 const root={...env,DB:env.GLOBAL_DB||env.DB};
 await run(root,'INSERT OR IGNORE INTO app_notifications(id,kind,product_id,workspace_name,lead_id,draft_id,title,body,created_at) VALUES(?,?,?,?,?,?,?,?,?)',`${env.PRODUCT_ID||'legacy'}:${event.key}`,event.kind,env.PRODUCT_ID||'',env.PRODUCT_NAME||'Existing outreach',event.leadId,event.draftId||null,event.title.slice(0,240),(event.body||'').slice(0,240),now());
}
export async function notificationPage(env:Env){
 const [items,unread]=await Promise.all([all<AppNotification>(env,'SELECT * FROM app_notifications ORDER BY created_at DESC,id DESC LIMIT 50'),one<{n:number}>(env,'SELECT COUNT(*) n FROM app_notifications WHERE read_at IS NULL')]);
 return {items,unread:unread?.n||0};
}
export async function readNotifications(env:Env,input:any){
 if(input.all===true)await run(env,'UPDATE app_notifications SET read_at=? WHERE read_at IS NULL',now());
 else{if(typeof input.id!=='string'||input.id.length>500)throw new Error('Choose a notification');await run(env,'UPDATE app_notifications SET read_at=coalesce(read_at,?) WHERE id=?',now(),input.id);}
 return notificationPage(env);
}
