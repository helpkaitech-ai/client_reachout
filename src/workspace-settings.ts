import type {Env,Settings,Product} from './types';
import {run,one,now} from './db';
import {cleanEmail} from './policy';

const targetingKeys=['offerContext','portfolio','locationIds','customerTypes','customerDescription','customerComments'] as const;
export async function prepareWorkspaceSettings(env:Env,previous:Settings,next:Settings,senderInput?:unknown){
 if(env.PRODUCT_ID&&(next.dailyLeadLimit>20||next.dailyResearchLimit>20||next.dailyTotalLimit>12||next.dailyNewLimit>12))throw new Error('Each product allows up to 20 researched leads and 12 emails per day');
 let profileChanged=false;
 if(env.PRODUCT_ID){
  const root={...env,DB:env.GLOBAL_DB!},p=await one<Product>(root,'SELECT * FROM products WHERE id=?',env.PRODUCT_ID);
  if(!p||p.revision!==env.PRODUCT_REVISION)throw new Error('Product changed in another window. Reload before saving');
  const sender=senderInput===undefined?p.sender_email:cleanEmail(senderInput);
  if(!sender)throw new Error('Enter a valid sender email authorized in the connected Gmail mailbox');
  profileChanged=targetingKeys.some(k=>JSON.stringify(Array.isArray(previous[k])?[...(previous[k] as string[])].sort():previous[k])!==JSON.stringify(Array.isArray(next[k])?[...(next[k] as string[])].sort():next[k]));
  if(profileChanged){
   const result=await run(root,"UPDATE products SET revision=revision+1,state='draft',approved_revision=NULL,analysis='{}',error=NULL,sender_email=?,updated_at=? WHERE id=? AND revision=?",sender,now(),p.id,p.revision);
   if(!result.meta.changes)throw new Error('Product changed. Reload before saving');
   next={...next,prospectingPaused:true,discoveryPaused:true};
   // Invalidate the root approval before changing local targeting, so stale
   // contexts cannot spend or send against the new configuration.
   await env.DB.batch([
    env.DB.prepare("UPDATE settings SET data=json_set(data,'$.prospectingPaused',json('true'),'$.discoveryPaused',json('true')) WHERE id=1"),
    env.DB.prepare("UPDATE jobs SET state='cancelled',updated_at=? WHERE state IN ('pending','running','paused','paused_provider')").bind(now()),
    env.DB.prepare("UPDATE drafts SET status='pending',quality_hold='Workspace targeting or offer changed; approve the new profile and improve or review this draft',approved_hash=NULL,approved_version=NULL,approved_at=NULL,updated_at=? WHERE status IN ('pending','approved')").bind(now())
   ]);
  }else if(sender!==p.sender_email){
   await run(root,'UPDATE products SET sender_email=?,updated_at=? WHERE id=? AND revision=?',sender,now(),p.id,p.revision);
  }
  if(sender!==p.sender_email)await run(env,"UPDATE drafts SET status='pending',approved_hash=NULL,approved_version=NULL,approved_at=NULL,updated_at=? WHERE status='approved'",now());
  env.SENDER_EMAIL=sender;
 }
 return {settings:next,profileChanged};
}
