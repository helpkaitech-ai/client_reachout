import type {Env,Lead,Settings,Draft} from './types';
import {one,run,now} from './db';
import {notifyInApp} from './notifications';

export const maxFollowups=3;
export async function conversationReady(env:Env,lead:Lead,kind:Draft['kind'],s:Settings){
 if(kind!=='followup')return true;
 const fresh=await one<Lead>(env,'SELECT * FROM leads WHERE id=?',lead.id);
 if(!fresh||fresh.status!=='contacted'||fresh.last_inbound_at||!fresh.next_followup_at||fresh.followup_count>=Math.min(maxFollowups,s.followupDays.length))return false;
 return !await one({...env,DB:env.GLOBAL_DB||env.DB},'SELECT email FROM suppressions WHERE email=?',fresh.email);
}
export async function followupDraftReady(env:Env,lead:Lead,kind:Draft['kind'],id:string){
 if(kind!=='followup')return;
 await run(env,'UPDATE drafts SET send_after=(SELECT next_followup_at FROM leads WHERE id=?) WHERE id=?',lead.id,id);
 await notifyInApp(env,{key:'followup-ready:'+id,kind:'followup_ready',leadId:lead.id,draftId:id,title:`Follow-up ${lead.followup_count+1} ready for ${lead.company}`,body:`Due ${lead.next_followup_at?.slice(0,10)}`});
}
