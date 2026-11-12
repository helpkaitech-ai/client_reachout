import type { Draft, Env, Lead, Settings } from './types';
import { acquire, release, all, audit, claimDaily, day, enqueue, now, one, run, uid } from './db';
import { approvalHash, approvalProblems, classifyInbound, cleanEmail, withinWindow, publicUrl } from './policy';
import { gmail, googleAccessToken, mimeMessage, sendGmail, telegram, ProviderError } from './providers';
import {requireProductReady,assertProductCurrent} from './products';
import {notifyInApp} from './notifications';
import {readyDraftSql} from './qualified-prospects';

export async function signature(env:Env,text:string) {
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.SESSION_SECRET||''),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return Buffer.from(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(text))).toString('base64url');
}
export async function unsubscribeUrl(env:Env,leadId:string) {
 return `${env.APP_URL}/unsubscribe?id=${encodeURIComponent(leadId)}${env.PRODUCT_ID?'&product='+encodeURIComponent(env.PRODUCT_ID):''}&sig=${await signature(env,'unsubscribe:'+(env.PRODUCT_ID?env.PRODUCT_ID+':':'')+leadId)}`;
}
const escapeHtml=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function messageText(d:Draft,s:Settings){return `${d.body.trim()}${d.artifact.trim()?'\n\nFree sample\n'+d.artifact.trim():''}\n\n${s.senderName}`;}
export function composedBody(d:Draft,s:Settings,_url:string){return messageText(d,s)+'\n\nTo unsubscribe, reply “unsubscribe”.';}
export type ProductLink={name:string;website:string};
export function productLink(env:Pick<Env,'PRODUCT_BRIEF'>):ProductLink|undefined{
 try{const p=JSON.parse(env.PRODUCT_BRIEF||'{}');return typeof p.name==='string'&&p.name.trim()&&publicUrl(p.website)?{name:p.name.trim(),website:publicUrl(p.website)!}:undefined;}catch{return undefined;}
}
export function linkedProductText(text:string,product?:ProductLink){
 const website=publicUrl(product?.website),name=product?.name.trim();
 if(!website||!name||name.length>200)return escapeHtml(text).replace(/\n/g,'<br>');
 const escaped=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 const pattern=new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`,'giu');
 // Keep existing URLs and email addresses intact; only link mentions in prose.
 const protectedToken=/(https?:\/\/[^\s<>]+|www\.[^\s<>]+|[\w.+-]+@[\w.-]+\.[a-z]{2,})/gi;
 return text.split(protectedToken).map((part,index)=>{
  if(index%2)return escapeHtml(part);
  let html='',cursor=0;
  for(const match of part.matchAll(pattern)){html+=escapeHtml(part.slice(cursor,match.index))+`<a href="${escapeHtml(website)}" target="_blank" rel="noopener noreferrer">${escapeHtml(match[0])}</a>`;cursor=match.index!+match[0].length;}
  return html+escapeHtml(part.slice(cursor));
 }).join('').replace(/\n/g,'<br>');
}
export function composedHtml(d:Draft,s:Settings,url:string,product?:ProductLink){
 const content=d.body.trim()+(d.artifact.trim()?'\n\nFree sample\n'+d.artifact.trim():'');
 return `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#222">${linkedProductText(content,product)}<br><br>${escapeHtml(s.senderName)}<p style="font-size:12px"><a href="${escapeHtml(url)}" style="color:#666">Unsubscribe</a></p></div>`;
}
export async function suppress(env:Env,lead:Lead,reason:string) {
 if(lead.email) await run({...env,DB:env.GLOBAL_DB||env.DB},'INSERT OR IGNORE INTO suppressions(email,reason,created_at) VALUES(?,?,?)',lead.email,reason,now());
 await env.DB.batch([
  env.DB.prepare("UPDATE leads SET status=?,next_followup_at=NULL,updated_at=? WHERE id=?").bind(reason==='bounce'?'bounced':'suppressed',now(),lead.id),
  env.DB.prepare("UPDATE drafts SET status='cancelled',approved_hash=NULL,updated_at=? WHERE lead_id=? AND status IN ('pending','approved')").bind(now(),lead.id),
  env.DB.prepare("UPDATE jobs SET state='cancelled',updated_at=? WHERE lead_id=? AND state IN ('pending','running','paused','paused_provider')").bind(now(),lead.id)
 ]);
 await audit(env,'suppressed',lead.id,reason);
}
export async function sendApproved(env:Env,s:Settings,draftId?:string,work?:{processed:number}) {
 if(env.ENABLE_SENDING!=='true'){requireProductReady(env);await assertProductCurrent(env);return;}
 const owner=await acquire(env,'dispatch',180);if(!owner)return;
 try{return await dispatchApproved(env,s,draftId,work);}finally{await release(env,'dispatch',owner);}
}
async function dispatchApproved(env:Env,s:Settings,draftId?:string,work?:{processed:number}) {
 requireProductReady(env);
 await assertProductCurrent(env);
 if(env.ENABLE_SENDING!=='true'||!env.SENDER_EMAIL||!env.APP_URL||!env.SESSION_SECRET)return;
 const candidates=await all<Draft & {timezone:string}>(env,"SELECT drafts.*,leads.timezone FROM drafts JOIN leads ON leads.id=drafts.lead_id WHERE drafts.status='approved' AND send_after<=? AND (? IS NULL OR drafts.id=?) ORDER BY send_after LIMIT 100",now(),draftId||null,draftId||null);
 const draft=candidates.find(d=>d.send_immediately===1||withinWindow(new Date(),d.timezone,s));
 if(!draft)return;
 if(work)work.processed++;
 let lead=await one<Lead>(env,'SELECT * FROM leads WHERE id=?',draft.lead_id);if(!lead)return;
 if(draft.kind==='followup'&&lead.next_followup_at&&Date.parse(lead.next_followup_at)>Date.now())return;
 if(!draft.send_immediately&&!withinWindow(new Date(),lead.timezone,s))return;
 // Poll this conversation immediately before dispatch. Do not send if inbox polling is unavailable.
 if(lead.thread_id){await syncThread(env,lead);lead=(await one<Lead>(env,'SELECT * FROM leads WHERE id=?',lead.id))!;}
 const fresh=await one<Draft>(env,'SELECT * FROM drafts WHERE id=?',draft.id);if(fresh?.status!=='approved')return;
 const errors=approvalProblems(draft,lead,s);
 if(await one({...env,DB:env.GLOBAL_DB||env.DB},'SELECT email FROM suppressions WHERE email=?',lead.email))errors.push('Recipient opted out');
 if(draft.kind!=='reply'&&lead.last_inbound_at)errors.push('A reply stopped this sequence');
 if(draft.kind==='reply'&&lead.last_inbound_at&&draft.approved_at&&lead.last_inbound_at>draft.approved_at)errors.push('A newer incoming message requires another review');
 if(draft.approved_version!==draft.version||draft.approved_hash!==await approvalHash(draft,lead,s,env.SENDER_EMAIL))errors.push('Content or sender details changed after approval');
 if(errors.length){await run(env,"UPDATE drafts SET status='pending',approved_hash=NULL,error=?,updated_at=? WHERE id=?",errors.join('; '),now(),draft.id);return;}
 const sendAs=await gmail(env,'settings/sendAs');
 if(!sendAs.sendAs?.some((a:any)=>a.sendAsEmail.toLowerCase()===env.SENDER_EMAIL!.toLowerCase()&&a.verificationStatus==='accepted'))throw new Error('Configured sender is not an accepted Gmail send-as address');
 // Usage is tracked for reporting, without a daily sending cap.
 await claimDaily(env,'send_slots',Number.MAX_SAFE_INTEGER);
 if(draft.kind==='initial')await claimDaily(env,'new_slots',Number.MAX_SAFE_INTEGER);
 const messageId=`<${draft.id}@${env.SENDER_EMAIL.split('@')[1]}>`;
 const raw=mimeMessage({from:env.SENDER_EMAIL,name:s.senderName,to:lead.email!,subject:draft.subject,body:composedBody(draft,s,await unsubscribeUrl(env,lead.id)),html:composedHtml(draft,s,await unsubscribeUrl(env,lead.id),productLink(env)),messageId,replyToId:draft.in_reply_to,unsubscribe:await unsubscribeUrl(env,lead.id)});
 const claimed=await run(env,`UPDATE drafts SET status='sending',message_id=?,updated_at=? WHERE id=? AND status='approved' AND version=?
 AND NOT EXISTS(SELECT 1 FROM suppressions WHERE email=?) AND EXISTS(SELECT 1 FROM leads WHERE id=? AND status NOT IN ('suppressed','closed','bounced'))`,messageId,now(),draft.id,draft.version,lead.email,lead.id);
 if(!claimed.meta.changes)return;
 try {
  const result=await sendGmail(env,raw,lead.thread_id);
  if(!result.id)throw new Error('Send response did not contain a message ID');
  await recordSent(env,s,draft,lead,result.id,result.threadId,messageId);
 }catch(error){
  const rejected=error instanceof ProviderError&&[400,401,403,404,429].includes(error.status);
  await run(env,'UPDATE drafts SET status=?,error=?,updated_at=? WHERE id=?',rejected?'failed':'uncertain',rejected?'Provider rejected message. Review before a fresh approval.':'Delivery outcome unknown. Reconcile against Sent mail; never blindly retry.',now(),draft.id);
  await audit(env,'send_'+(rejected?'failed':'uncertain'),draft.id,'Inspect provider status before taking further action');
 }
}
export async function recordSent(env:Env,s:Settings,d:Draft,l:Lead,providerId:string,threadId:string,messageId:string) {
 if((await one<Draft>(env,'SELECT * FROM drafts WHERE id=?',d.id))?.status==='sent')return;
 const at=now(); const count=l.followup_count+(d.kind==='followup'?1:0);
 // followupDays are offsets from the first send, so use differences after each follow-up.
 const delay=d.kind==='initial'?s.followupDays[0]:d.kind==='followup'&&count<Math.min(3,s.followupDays.length)?s.followupDays[count]-s.followupDays[count-1]:null;
 const due=delay&&!l.last_inbound_at?new Date(Date.now()+delay*86400000).toISOString():null;
 await env.DB.batch([
  env.DB.prepare("UPDATE drafts SET status='sent',provider_id=?,error=NULL,updated_at=? WHERE id=?").bind(providerId,at,d.id),
  env.DB.prepare("UPDATE leads SET status=?,thread_id=?,last_sent_at=?,next_followup_at=?,followup_count=?,updated_at=? WHERE id=?").bind(d.kind==='reply'?'replied':'contacted',threadId||l.thread_id,at,due,count,at,l.id),
  env.DB.prepare("INSERT OR IGNORE INTO messages(id,lead_id,direction,subject,body,rfc_id,created_at) VALUES(?,?,'outbound',?,?,?,?)").bind(providerId,l.id,d.subject,d.body,messageId,at)
 ]);
 await audit(env,'email_sent',d.id,'Provider accepted the message; acceptance is not proof of inbox delivery');
}
function bodyText(part:any):string {
 if(part.mimeType==='text/plain'&&part.body?.data)return Buffer.from(part.body.data,'base64url').toString('utf8');
 for(const p of part.parts||[]){const text=bodyText(p);if(text)return text;}
 if(part.mimeType==='text/html'&&part.body?.data)return Buffer.from(part.body.data,'base64url').toString('utf8').replace(/<[^>]*>/g,' ').slice(0,15000);
 return '';
}
export async function ingestMessage(env:Env,lead:Lead,message:any) {
 const existing=await one<any>(env,"SELECT * FROM messages WHERE id=? AND direction='inbound'",message.id);
 if(existing){await inboundNotice(env,lead,message.id,existing.classification,existing.body);return;}
 const headers:Record<string,string>={};for(const h of message.payload?.headers||[])headers[h.name.toLowerCase()]=h.value;
 if(message.labelIds?.includes('SENT'))return;
 const from=cleanEmail(headers.from?.match(/<([^>]+)>/)?.[1]||headers.from);
 if(from===cleanEmail(env.SENDER_EMAIL))return;
 const body=(bodyText(message.payload||{})||message.snippet||'').slice(0,15000);
 const classification=classifyInbound(body,headers);
 const at=now();
 const inserted=await run(env,"INSERT OR IGNORE INTO messages(id,lead_id,direction,subject,body,rfc_id,classification,created_at) VALUES(?,?,'inbound',?,?,?,?,?)",message.id,lead.id,headers.subject||'',body,headers['message-id']||null,classification,at);if(!inserted.meta.changes)return;
 await run(env,"UPDATE leads SET last_inbound_at=?,next_followup_at=NULL,status=?,thread_id=COALESCE(?,thread_id),updated_at=? WHERE id=?",at,classification==='automatic'?'automatic':'replied',message.threadId||null,at,lead.id);
 await run(env,"UPDATE drafts SET status='cancelled',approved_hash=NULL,updated_at=? WHERE lead_id=? AND status IN ('pending','approved')",at,lead.id);
 await run(env,"UPDATE jobs SET state='cancelled',updated_at=? WHERE lead_id=? AND state IN ('pending','running','paused','paused_provider')",at,lead.id);
 if(classification==='optout'||classification==='bounce')await suppress(env,lead,classification);
 else if(classification==='reply')await enqueue(env,'reply',lead.id,{inboundId:message.id},'reply:'+message.id);
 await inboundNotice(env,lead,message.id,classification,body);
 await audit(env,'inbound_'+classification,lead.id,'Incoming message recorded; any pending sequence was stopped');
}
async function inboundNotice(env:Env,lead:Lead,id:string,classification:string,text:string){
 const label=classification==='bounce'?'Email bounced':classification==='optout'?'Unsubscribed':classification==='automatic'?'Automatic reply received':'Reply received';
 await notifyInApp(env,{key:'inbound:'+id,kind:classification,leadId:lead.id,title:`${label}: ${lead.company}`,body:text.replace(/\s+/g,' ').slice(0,180)});
}
export async function syncThread(env:Env,lead:Lead,token?:string) {
 if(!lead.thread_id)return;
 const thread=await gmail(env,`threads/${encodeURIComponent(lead.thread_id)}?format=full`,{},token);
 for(const m of thread.messages||[])await ingestMessage(env,lead,m);
}
export async function syncInbox(env:Env,work?:{processed:number}):Promise<boolean> {
 const token=await googleAccessToken(env);
 const row=await one<{value:string}>(env,"SELECT value FROM integration_state WHERE key='inbox_cursor'");
 const cursor=row?JSON.parse(row.value):{after:Math.floor(Date.now()/1000)-30*86400,before:0,page:''};
 if(!cursor.before)cursor.before=Math.floor(Date.now()/1000)+1;
 const query=`after:${cursor.after} before:${cursor.before} -in:sent -in:drafts`;
 const recent=await gmail(env,'messages?maxResults=1&q='+encodeURIComponent(query)+(cursor.page?'&pageToken='+encodeURIComponent(cursor.page):''),{},token);
 for(const item of recent.messages||[]) {
  if(await one(env,'SELECT id FROM inbox_seen WHERE id=?',item.id))continue;
  if(await one(env,'SELECT id FROM messages WHERE id=?',item.id))continue;
  if(work)work.processed++;
  const m=await gmail(env,`messages/${encodeURIComponent(item.id)}?format=full`,{},token);
  const headers:Record<string,string>={};for(const h of m.payload?.headers||[])headers[h.name.toLowerCase()]=h.value;
  const from=cleanEmail(headers.from?.match(/<([^>]+)>/)?.[1]||headers.from);
  let lead=await one<Lead>(env,'SELECT * FROM leads WHERE thread_id=?',m.threadId);
  if(!lead&&from&&!env.PRODUCT_ID)lead=await one<Lead>(env,'SELECT * FROM leads WHERE email=? AND last_sent_at IS NOT NULL',from);
  if(!lead&&/mailer-daemon|postmaster/i.test(headers.from||'')) {
   const text=bodyText(m.payload||{});const id=text.match(/<([a-f0-9-]{36})@[^>]+>/i)?.[1];
   if(id)lead=await one<Lead>(env,'SELECT leads.* FROM leads JOIN drafts ON drafts.lead_id=leads.id WHERE drafts.id=?',id);
   if(!lead) {const address=cleanEmail(text.match(/Final-Recipient:\s*rfc822;\s*([^\s]+)/i)?.[1]);if(address)lead=await one<Lead>(env,'SELECT * FROM leads WHERE email=?',address);}
  }
  if(lead)await ingestMessage(env,lead,m);
  await run(env,'INSERT OR IGNORE INTO inbox_seen(id,observed_at) VALUES(?,?)',item.id,now());
 }
 const complete=!recent.nextPageToken;
 const next=complete?{after:cursor.before-120,before:0,page:''}:{...cursor,page:recent.nextPageToken};
 await run(env,"INSERT INTO integration_state(key,value) VALUES('inbox_cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",JSON.stringify(next));
 return complete;
}
export async function reconcile(env:Env,s:Settings,id:string) {
 const d=await one<Draft>(env,"SELECT * FROM drafts WHERE id=? AND status IN ('uncertain','sending')",id);
 if(!d?.message_id)throw new Error('No uncertain message to reconcile');
 const search=await gmail(env,'messages?q='+encodeURIComponent('in:sent rfc822msgid:'+d.message_id));
 if(!search.messages?.length)throw new Error('Not found in Sent mail. Outcome remains uncertain; do not automatically retry.');
 const m=search.messages[0];const lead=(await one<Lead>(env,'SELECT * FROM leads WHERE id=?',d.lead_id))!;
 await recordSent(env,s,d,lead,m.id,m.threadId,d.message_id);
}
export async function notifyDigest(env:Env,s:Settings,force=false) {
 if(env.ENABLE_NOTIFICATIONS!=='true')return;
 const pending=await one<{n:number}>(env,`SELECT COUNT(DISTINCT lower(l.email)) n FROM drafts d JOIN leads l ON l.id=d.lead_id WHERE d.status='pending' AND ${readyDraftSql(!!env.PRODUCT_ID)}`);
 const failed=await one<{n:number}>(env,"SELECT COUNT(*) n FROM jobs WHERE state IN ('failed','uncertain')");
 if(!force&&!pending?.n&&!failed?.n)return;
 const content=`${env.PRODUCT_NAME||'Relay'}: ${pending?.n||0} drafts ready${failed?.n?` · ${failed.n} tasks need attention`:''}\n${env.APP_URL}${env.PRODUCT_ID?'/?product='+encodeURIComponent(env.PRODUCT_ID):''}`;
 for(const channel of ['telegram','email']) {
  if(channel==='telegram'&&(!env.TELEGRAM_BOT_TOKEN||!env.TELEGRAM_CHAT_ID))continue;
  if(channel==='email'&&!cleanEmail(env.NOTIFY_EMAIL))continue;
  const milestone=(pending?.n||0)>=20?20:Math.floor((pending?.n||0)/5)*5||((pending?.n||0)>0?1:0);
  const id=`${day()}:${channel}:review-${milestone}${force?':'+uid():''}`;
  const inserted=await run(env,'INSERT OR IGNORE INTO notifications(id,channel,state,created_at) VALUES(?,?,?,?)',id,channel,'sending',now());if(!inserted.meta.changes)continue;
  try{
   if(channel==='telegram')await telegram(env,content);
   else await sendGmail(env,mimeMessage({from:env.SENDER_EMAIL!,name:s.senderName,to:env.NOTIFY_EMAIL!,subject:'Relay: your outreach review',body:content,messageId:`<notice-${uid()}@prepyr.com>`}));
   await run(env,"UPDATE notifications SET state='sent' WHERE id=?",id);
  }catch{await run(env,"UPDATE notifications SET state='failed',error='Check notification credentials and provider logs' WHERE id=?",id);}
 }
}
