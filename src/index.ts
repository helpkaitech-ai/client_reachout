import type { Env, Lead, Draft, Settings } from './types';
import { acquire, all, audit, day, enqueue, month, now, one, release, run, settings } from './db';
import { authenticated, csrf, login, logout, sameSecret, AuthUnavailable } from './auth';
export { RelayAuthStore } from './auth-store';
export { WorkspaceBackup } from './workspace-backup';
import {backupStatus,forwardBackupImport,savedWorkspace,refreshBackup,isD1Unavailable} from './workspace-backup';
import {backupTables} from './workspace-schema';
import { approvalHash, approvalProblems, cleanEmail, publicUrl, validTimezone, validateSettings } from './policy';
import { importLead, startDiscovery, searchHistory, discoveryPause } from './discovery';
import { notifyDigest, reconcile, signature, suppress, composedBody, unsubscribeUrl, sendApproved, syncInbox } from './mail';
import { tick, researchBacklog } from './engine';
import {tickWorkspaces} from './engine';
export {ProductWorkspace} from './product-store';
import {product,productList,productDetail,saveProduct,scopeProduct,queueProductAnalysis,approveProduct,advanceProductAnalysis,requireProductReady} from './products';
import {locationOptions, validateLocations, manualSearchPlan} from './locations';
import { gmail, jsonRequest } from './providers';
import { prospectPage, prospectDetail } from './prospects';
import {notificationPage,readNotifications} from './notifications';
import {assertOutreachRunning,controlOutreach} from './outreach-control';

const isDatabaseLimit=(e:unknown)=>/D1_ERROR:.*(?:daily row (?:read|write) limit|free tier|quota)/i.test(e instanceof Error?e.message:'');
const json=(data:unknown,status=200,headers:Record<string,string>={})=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json',...headers}});
async function body(request:Request,limit=200000) {
 if(Number(request.headers.get('Content-Length')||0)>limit)throw new Error('Request is too large');
 const text=await request.text();if(text.length>limit)throw new Error('Request is too large');return JSON.parse(text||'{}');
}
function connections(env:Env,s:Settings) {
 return {
  openai:!!env.OPENAI_API_KEY,discoveryProvider:'openai',
  gmail:!!(env.GOOGLE_CLIENT_ID&&env.GOOGLE_CLIENT_SECRET&&env.GOOGLE_REFRESH_TOKEN),
  telegram:!!(env.TELEGRAM_BOT_TOKEN&&env.TELEGRAM_CHAT_ID),
  notificationEmail:env.NOTIFY_EMAIL||'',sender:env.SENDER_EMAIL||'',
  automationEnabled:env.ENABLE_AUTOMATION==='true'&&!s.outreachPaused,sendingEnabled:env.ENABLE_SENDING==='true'&&!s.outreachPaused,notificationsEnabled:env.ENABLE_NOTIFICATIONS==='true'&&!s.outreachPaused,
  postalAddress:!!s.businessAddress,providerPolicyConfirmed:s.providerPolicyConfirmed,
  researchModel:env.OPENAI_RESEARCH_MODEL||'gpt-5.4-mini',draftModel:env.OPENAI_DRAFT_MODEL||'gpt-5.6-sol'
 };
}
async function dashboard(env:Env,compact=false) {
 const s=await settings(env);
 const [stats,usage,budgets,drafts,leads,messages,jobs,events,runs,notifications,expenses]=await Promise.all([
  all(env,'SELECT status,COUNT(*) count FROM leads GROUP BY status'),
  one(env,'SELECT * FROM daily_usage WHERE day=?',day()),
  all(env,`SELECT provider,SUM(CASE WHEN state='settled' THEN actual ELSE reserved END) committed,
   SUM(CASE WHEN state='settled' THEN actual ELSE 0 END) estimated,SUM(CASE WHEN state<>'settled' THEN reserved ELSE 0 END) reserved FROM expenses WHERE month=? GROUP BY provider`,month()),
  compact?Promise.resolve([]):all(env,'SELECT drafts.*,leads.company,leads.email,leads.country,leads.industry FROM drafts JOIN leads ON leads.id=drafts.lead_id ORDER BY drafts.created_at DESC LIMIT 250'),
  compact?Promise.resolve([]):all(env,'SELECT * FROM leads ORDER BY created_at DESC LIMIT 500'),
  compact?Promise.resolve([]):all(env,'SELECT messages.*,leads.company FROM messages JOIN leads ON leads.id=messages.lead_id ORDER BY messages.created_at DESC LIMIT 100'),
  all(env,'SELECT jobs.*,leads.company FROM jobs LEFT JOIN leads ON leads.id=jobs.lead_id ORDER BY jobs.created_at DESC LIMIT 60'),
  all(env,'SELECT * FROM events ORDER BY id DESC LIMIT 60'),all(env,'SELECT * FROM discovery_batches ORDER BY created_at DESC LIMIT 20'),
  compact?Promise.resolve([]):all(env,'SELECT * FROM notifications ORDER BY created_at DESC LIMIT 10'),compact?Promise.resolve([]):all(env,'SELECT * FROM expenses ORDER BY created_at DESC LIMIT 100')
 ]);
 const metrics=await one(env,`SELECT
 (SELECT COUNT(*) FROM leads) prospects,
 (SELECT COUNT(*) FROM drafts WHERE status='pending') review,
 (SELECT COUNT(*) FROM drafts WHERE status='sent') sent,
 (SELECT COUNT(*) FROM drafts WHERE status='sent' AND updated_at>=?) sentToday,
 (SELECT COUNT(*) FROM drafts WHERE status='sent' AND kind='followup') followupsSent,
 (SELECT COUNT(DISTINCT lead_id) FROM messages WHERE direction='inbound' AND classification='reply') replies,
 (SELECT COUNT(*) FROM leads WHERE next_followup_at IS NOT NULL AND last_inbound_at IS NULL AND status='contacted') followupsScheduled,
 (SELECT COUNT(*) FROM drafts WHERE status='approved') scheduled,
 (SELECT COUNT(*) FROM jobs WHERE state IN ('pending','running') AND kind IN ('research','rewrite')) researching,
 (SELECT COUNT(*) FROM drafts WHERE kind='initial' AND quality_hold='' AND created_at>=?) draftedToday`,day()+'T00:00:00.000Z',day()+'T00:00:00.000Z');
 const enrichedDrafts=(drafts as any[]).map(d=>{const l=(leads as Lead[]).find(l=>l.id===d.lead_id);return {...d,sendIssues:l?approvalProblems(d,{...l,eligibility:l.eligibility==='ineligible'?'ineligible':'eligible',eligibility_note:'Confirmed at approval',verification:l.verification==='invalid'?'invalid':'owner_reviewed'},s):['Prospect record not in current view']};});
 const pipeline={provider:'openai',pausedJobs:(await one<{n:number}>(env,"SELECT COUNT(*) n FROM jobs WHERE state IN ('paused','paused_provider')"))?.n||0,waitingResearch:await researchBacklog(env),attentionJobs:(await one<{n:number}>(env,"SELECT COUNT(*) n FROM jobs WHERE state IN ('failed','uncertain')"))?.n||0};
 return {settings:s,locationOptions,connections:connections(env,s),metrics,stats,usage,budgets,pipeline,drafts:enrichedDrafts,leads,messages,jobs,events,runs,notifications,expenses,date:day()};
}
async function mutate(request:Request,env:Env,path:string,input:any) {
 const s=await settings(env);
 if(path==='/api/discovery/control'){
  if(typeof input.paused!=='boolean')throw new Error('Choose whether discovery is paused');
  if(!input.paused){await assertOutreachRunning(env);requireProductReady(env);}
  await run(env,'INSERT OR IGNORE INTO settings(id,data) VALUES(1,?)',JSON.stringify(s));
  await run(env,"UPDATE settings SET data=json_set(data,'$.discoveryPaused',json(?),'$.discoveryIntervalDays',6,'$.discoveryPausedUntil','') WHERE id=1",JSON.stringify(input.paused));
  await audit(env,input.paused?'discovery_paused':'discovery_resumed',null,'Owner changed discovery; automatic interval is six days');return {ok:true,message:input.paused?'Discovery paused until you resume it.':'Discovery resumed. Automatic searches run at six-day intervals.'};
 }
 if(['/api/discover','/api/discovery/sync','/api/notify'].includes(path)||/\/(research|rewrite|approve|retry)$/.test(path))await assertOutreachRunning(env);
 if(env.PRODUCT_ID&&(/^\/api\/(discover|import)$/.test(path)||/\/(research|rewrite|approve)$/.test(path)))requireProductReady(env);
 if(['/api/settings','/api/settings/sender','/api/settings/locations','/api/settings/preferences'].includes(path)) {
  const candidate=path.endsWith('/sender')?{...s,senderName:String(input.senderName||'').trim(),businessAddress:String(input.businessAddress||'').trim()}:path.endsWith('/locations')?{...s,locationIds:validateLocations(input.locationIds)}:path.endsWith('/preferences')?{...input,senderName:s.senderName,businessAddress:s.businessAddress,locationIds:s.locationIds,campaigns:s.campaigns}:input;
  const next=validateSettings({...candidate,outreachPaused:s.outreachPaused,discoveryPaused:s.discoveryPaused,discoveryPausedUntil:s.discoveryPausedUntil,discoveryIntervalDays:6});await run(env,`INSERT INTO settings(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=json_set(excluded.data,'$.outreachPaused',json(CASE WHEN json_extract(settings.data,'$.outreachPaused')=1 THEN 'true' ELSE 'false' END),'$.discoveryPaused',json(CASE WHEN json_extract(settings.data,'$.discoveryPaused')=1 THEN 'true' ELSE 'false' END),'$.discoveryPausedUntil',coalesce(json_extract(settings.data,'$.discoveryPausedUntil'),''),'$.discoveryIntervalDays',6)`,JSON.stringify(next));
  if(next.senderName!==s.senderName||next.businessAddress!==s.businessAddress)await run(env,"UPDATE drafts SET status='pending',approved_hash=NULL,approved_version=NULL WHERE status='approved'");
  await audit(env,'settings_changed',null,'Owner updated settings');return {ok:true,settings:next,connections:connections(env,next)};
 }
 if(path==='/api/import') {
  const records=Array.isArray(input)?input:input.leads;if(!Array.isArray(records)||records.length>100)throw new Error('Import 1–100 lead records at a time');
  let added=0,duplicates=0;const errors:string[]=[];
  for(let i=0;i<records.length;i++){try{await importLead(env,records[i])?added++:duplicates++;}catch(e){errors.push(`Row ${i+1}: ${e instanceof Error?e.message:'invalid'}`);}}
  await audit(env,'leads_imported',null,`${added} added; ${duplicates} duplicates; ${errors.length} invalid`);return {added,duplicates,errors};
 }
 if(path==='/api/discover'||path==='/api/discovery/sync'){
  if(s.discoveryPaused)return {state:'paused',message:'Discovery is paused. Resume discovery in this prospect workspace.'};
  if(!env.OPENAI_API_KEY)throw new Error('Configure OpenAI before finding prospects');
  const resumeAt=discoveryPause(s);if(resumeAt)return {state:'paused',resumeAt,message:`New prospect searches are paused until ${resumeAt}. Existing business research continues.`};
  if(path==='/api/discovery/sync')return {ok:true,message:'Search stages resume automatically.'};
  const active=await one<any>(env,"SELECT * FROM discovery_batches WHERE state IN ('queued','running','budget_paused') LIMIT 1");
  if(active)return {state:active.state,runId:active.id,message:'Your prospect search is already running or queued. Results appear automatically.'};
  if(env.PRODUCT_ID){const history=await searchHistory(env),choices=s.campaigns.filter(c=>c.enabled),selected=choices[history.reduce((n,h)=>n+Number(h.uses),0)%choices.length];if(!selected)throw new Error('Approve a customer profile with enabled search scopes first');return startDiscovery(env,s,selected,crypto.randomUUID());}
  const plan=env.PRODUCT_ID?s.campaigns.filter(c=>c.enabled):manualSearchPlan(s,await searchHistory(env));const batch=crypto.randomUUID();let first;
  for(const [index,campaign] of plan.entries()){const result=await startDiscovery(env,s,campaign,batch+':'+index);if(!first)first=result;}
  return {...first,locations:plan.map(c=>c.location),message:plan.length>1?`Queued ${plan.length} location searches. Public business research continues automatically.`:first?.message};
 }
 if(path==='/api/notify'){await notifyDigest(env,s,true);return {ok:true};}
 if(path==='/api/connections/check') {
  const results:Record<string,string>={};
  if(env.OPENAI_API_KEY){try{await jsonRequest('OpenAI','https://api.openai.com/v1/models/'+encodeURIComponent(env.OPENAI_DRAFT_MODEL||'gpt-5.6-sol'),{headers:{Authorization:`Bearer ${env.OPENAI_API_KEY}`}});results.openai='Model accessible (read-only check)';}catch{results.openai='Connection/model check failed';}}
  if(env.GOOGLE_REFRESH_TOKEN){try{const p=await gmail(env,'profile');results.gmail=`Connected mailbox: ${p.emailAddress}`;const aliases=await gmail(env,'settings/sendAs');const valid=aliases.sendAs?.find((a:any)=>a.sendAsEmail===env.SENDER_EMAIL&&a.verificationStatus==='accepted');results.sender=valid?'Sender address is configured':'Sender address is not an accepted Gmail send-as address';}catch{results.gmail='Check OAuth credentials, enabled Gmail API and scopes';}}
  if(env.TELEGRAM_BOT_TOKEN){try{await jsonRequest('Telegram',`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`);results.telegram='Bot authenticated; chat access is checked when notifying';}catch{results.telegram='Bot authentication failed';}}
  return results;
 }
 const leadMatch=path.match(/^\/api\/leads\/([^/]+)\/(update|research|verify|suppress|close)$/);
 if(leadMatch) {
  const [,id,action]=leadMatch;const lead=await one<Lead>(env,'SELECT * FROM leads WHERE id=?',id);if(!lead)throw new Error('Prospect not found');
  if(action==='verify')throw new Error('Automatic mailbox verification was removed. Review the public email evidence or update the contact manually.');
  if(action==='research'){
   if(['suppressed','closed'].includes(lead.status))throw new Error('Prospect is not active');
   if(action==='research'&&await one(env,"SELECT id FROM drafts WHERE lead_id=? AND status IN ('pending','approved','sending','uncertain')",id))throw new Error('Review or reject the existing draft first');
   if(action==='research'&&await one(env,"SELECT id FROM jobs WHERE lead_id=? AND kind IN ('research','rewrite') AND state IN ('pending','running','uncertain','failed','paused','paused_provider')",id))throw new Error('This prospect already has a research task. Check its status in Settings > Activity & costs before starting more paid work.');
   return {job:await enqueue(env,action,id)};
  }
  if(action==='suppress'){await suppress(env,lead,'Owner requested suppression');return {ok:true};}
  if(action==='close'){await run(env,"UPDATE leads SET status='closed',next_followup_at=NULL WHERE id=?",id);await run(env,"UPDATE drafts SET status='cancelled',approved_hash=NULL WHERE lead_id=? AND status IN ('pending','approved')",id);return {ok:true};}
  const email=cleanEmail(input.email);if(input.email&&!email)throw new Error('Invalid email');
  if(lead.last_sent_at&&email!==lead.email)throw new Error('This business already has a conversation. Add a separate prospect to contact a different address.');
  const zone=String(input.timezone||lead.timezone);if(!validTimezone(zone))throw new Error('Invalid timezone');
  if(!['pending','eligible','ineligible'].includes(input.eligibility))throw new Error('Invalid outreach eligibility');
  if(input.eligibility==='eligible'&&String(input.eligibility_note||'').trim().length<15)throw new Error('Document why outreach is eligible for this recipient');
  const verified=input.verification==='manual'?'manual':lead.verification;
  if(verified==='manual'&&String(input.verification_note||'').trim().length<15)throw new Error('Record the source and date of manual email verification');
  await run(env,'UPDATE leads SET email=?,contact_name=?,timezone=?,eligibility=?,eligibility_note=?,verification=?,verification_note=?,updated_at=? WHERE id=?',email,String(input.contact_name||'').slice(0,120),zone,input.eligibility,String(input.eligibility_note||'').slice(0,2000),email!==lead.email&&verified!=='manual'?'unverified':verified,String(input.verification_note||lead.verification_note).slice(0,2000),now(),id);
  if(verified==='manual'&&String(input.verification_note||'').trim().length>=15)await run(env,"UPDATE leads SET contact_status='owner_reviewed' WHERE id=?",id);
  await run(env,"UPDATE drafts SET status='pending',approved_hash=NULL,approved_version=NULL WHERE lead_id=? AND status='approved'",id);
  await audit(env,'prospect_updated',id,'Owner updated contact and eligibility review');return {ok:true};
 }
 const draftMatch=path.match(/^\/api\/drafts\/([^/]+)\/(edit|approve|reject|reconcile|rewrite)$/);
 if(draftMatch) {
  const [,id,action]=draftMatch;const d=await one<Draft>(env,'SELECT * FROM drafts WHERE id=?',id);if(!d)throw new Error('Draft not found');
  const lead=(await one<Lead>(env,'SELECT * FROM leads WHERE id=?',d.lead_id))!;
  if(action==='reconcile'){await reconcile(env,s,id);return {ok:true};}
  if(action==='rewrite'){
   if(d.status!=='pending'||d.version!==input.version)throw new Error('Only the current unsent draft can be improved. Refresh and try again.');
   return {job:await enqueue(env,'rewrite',lead.id,{draftId:id,version:d.version,kind:d.kind},`rewrite:${id}:${d.version}`)};
  }
  // A repeated approval request returns the existing outcome and never sends twice.
  if(action==='approve'&&['sent','sending','uncertain','approved'].includes(d.status))return {ok:true,status:d.status,message:d.status==='sent'?'Already sent through Gmail.':d.status==='approved'?'Already approved; dispatch will continue automatically.':'Dispatch is in progress or awaiting reconciliation. Do not send again.'};
  if(!['pending','approved','failed'].includes(d.status))throw new Error('This draft cannot be changed in its current state');
  if(input.version!==d.version)throw new Error('Draft changed since you opened it. Refresh and review the current version.');
  if(action==='edit') {
   if(typeof input.subject!=='string'||/[\r\n]/.test(input.subject)||!input.subject.trim()||input.subject.length>180||typeof input.body!=='string'||input.body.length>12000||typeof input.artifact!=='string'||input.artifact.length>15000)throw new Error('Invalid draft content');
   await run(env,"UPDATE drafts SET subject=?,body=?,artifact=?,version=version+1,status='pending',approved_version=NULL,approved_hash=NULL,approved_at=NULL,updated_at=? WHERE id=?",input.subject,input.body,input.artifact,now(),id);
  }else if(action==='reject'){
   await run(env,"UPDATE drafts SET status='rejected',approved_hash=NULL,updated_at=? WHERE id=?",now(),id);
   await run(env,"UPDATE leads SET status='held',next_followup_at=NULL,updated_at=? WHERE id=?",now(),lead.id);
  }else{
   if(input.evidenceReviewed!==true)throw new Error('Review the recipient, research and message before approving');
   const reviewedLead={...lead};
   if(input.contactReviewed===true){
    if(lead.eligibility==='ineligible')throw new Error('This recipient is marked ineligible for outreach');
    reviewedLead.eligibility='eligible';reviewedLead.eligibility_note=`Owner confirmed the recipient and outreach basis while approving draft ${id} on ${now()}`;
    if(!['valid','manual','invalid'].includes(lead.verification)){reviewedLead.verification='owner_reviewed';reviewedLead.verification_note=`Owner reviewed this recipient email and public evidence on ${now()}; not a deliverability guarantee.`;}
   }
   const errors=approvalProblems(d,reviewedLead,s);
   if(env.ENABLE_SENDING!=='true')errors.push('Gmail sending is not activated. Research and drafting remain automatic.');
   if(await one({...env,DB:env.GLOBAL_DB||env.DB},'SELECT email FROM suppressions WHERE email=?',lead.email))errors.push('Email is suppressed');
   if(d.kind!=='reply'&&lead.last_inbound_at)errors.push('Prospect has replied; use a reply draft');
   if(!cleanEmail(env.SENDER_EMAIL))errors.push('Set SENDER_EMAIL first');
   if(errors.length)throw new Error(errors.join('; '));
   if(input.contactReviewed===true)await run(env,'UPDATE leads SET eligibility=?,eligibility_note=?,verification=?,verification_note=?,updated_at=? WHERE id=?',reviewedLead.eligibility,reviewedLead.eligibility_note,reviewedLead.verification,reviewedLead.verification_note,now(),lead.id);
   let scheduled=input.sendAfter?new Date(input.sendAfter):new Date();if(!Number.isFinite(scheduled.getTime()))throw new Error('Invalid schedule');
   if(d.kind==='followup'&&lead.next_followup_at)scheduled=new Date(Math.max(scheduled.getTime(),Date.parse(lead.next_followup_at)));
   await run(env,"UPDATE drafts SET status='approved',approved_version=version,approved_hash=?,approved_at=?,send_after=?,send_immediately=?,error=NULL,updated_at=? WHERE id=?",await approvalHash(d,lead,s,env.SENDER_EMAIL!),now(),scheduled.toISOString(),input.sendAfter||scheduled.getTime()>Date.now()?0:1,now(),id);
   await audit(env,'draft_approve',id,`Owner approved version ${d.version} for Gmail dispatch`);
   try{
    if(await syncInbox(env))await sendApproved(env,s,id);
    else await run(env,'UPDATE drafts SET error=? WHERE id=?','Approved. Inbox synchronization is catching up; sending will continue automatically.',id);
   }catch{await run(env,"UPDATE drafts SET error=? WHERE id=? AND status='approved'",'Approved. Gmail connection needs attention; the scheduler will retry dispatch without another approval.',id);}
   const outcome=await one<Draft>(env,'SELECT * FROM drafts WHERE id=?',id);
   return {ok:true,status:outcome?.status,message:outcome?.status==='sent'?'Sent through your Gmail account.':outcome?.status==='approved'?(outcome.error||'Approved. Scheduled sending will run automatically; no second approval needed.'):outcome?.error||'Check delivery status in Activity.'};
  }
  await audit(env,'draft_'+action,id,`Owner acted on version ${d.version}`);return {ok:true};
 }
 const jobMatch=path.match(/^\/api\/jobs\/([^/]+)\/retry$/);
 if(jobMatch){
  const job=await one<any>(env,'SELECT * FROM jobs WHERE id=?',jobMatch[1]);if(!job||!['failed','paused_provider'].includes(job.state))throw new Error('Only failed jobs can be deliberately retried. Uncertain work requires provider reconciliation.');
  if(input.confirmPaidRetry!==true)throw new Error('Confirm this retry may incur a new provider charge');
  const payload=JSON.parse(job.payload);payload.retryVersion=(payload.retryVersion||0)+1;await run(env,"UPDATE jobs SET state='pending',payload=?,error=NULL,next_run_at=NULL,updated_at=? WHERE id=?",JSON.stringify(payload),now(),job.id);return {ok:true};
 }
 throw new Error('Unknown action');
}
function isWorkspaceRead(path:string){return ['/api/dashboard','/api/prospects','/api/export'].includes(path)||/^\/api\/prospects\/[^/]+$/.test(path)||/^\/api\/drafts\/[^/]+\/preview$/.test(path);}
async function readWorkspace(request:Request,env:Env,saved=false):Promise<Response>{
 const url=new URL(request.url),path=url.pathname;
 if(path==='/api/export'&&saved){const tables:Record<string,unknown[]>={};for(const table of backupTables)tables[table]=await all(env,'SELECT * FROM '+table);return json({scope:'Saved workspace views',...tables},200,{'Content-Disposition':'attachment; filename="relay-saved-workspace.json"'});}
 if(path==='/api/dashboard'&&request.method==='GET')return json(await dashboard(env,url.searchParams.get('summary')==='1'));
 if(path==='/api/prospects'&&request.method==='GET')return json(await prospectPage(env,url));
 const detail=path.match(/^\/api\/prospects\/([^/]+)$/);
 if(detail&&request.method==='GET'){if(!await one(env,'SELECT id FROM leads WHERE id=?',detail[1]))return json({error:'Prospect not found'},404);return json(await prospectDetail(env,detail[1]));}
 if(path==='/api/export'&&request.method==='GET')return json({leads:await all(env,'SELECT * FROM leads'),drafts:await all(env,'SELECT * FROM drafts'),messages:await all(env,'SELECT * FROM messages'),expenses:await all(env,'SELECT * FROM expenses'),suppressions:await all(env,'SELECT * FROM suppressions'),facts:await all(env,'SELECT * FROM business_facts'),searches:await all(env,'SELECT * FROM discovery_batches'),candidates:await all(env,'SELECT * FROM discovery_candidates'),tasks:await all(env,'SELECT * FROM jobs'),attempts:await all(env,'SELECT id,job_id,stage,state,expense_id,model,request_id,response_id,error,created_at,updated_at FROM ai_attempts')},200,{'Content-Disposition':'attachment; filename="relay-export.json"'});
 const preview=path.match(/^\/api\/drafts\/([^/]+)\/preview$/);
 if(preview&&request.method==='GET'){
  const d=await one<Draft>(env,'SELECT * FROM drafts WHERE id=?',preview[1]);if(!d)return json({error:'Not found'},404);
  const s=await settings(env);return json({from:`${s.senderName} <${env.SENDER_EMAIL||''}>`,subject:d.subject,body:composedBody(d,s,await unsubscribeUrl(env,d.lead_id))});
 }
 return json({error:'Not found'},404);
}
async function route(request:Request,env:Env,ctx:ExecutionContext):Promise<Response> {
 const url=new URL(request.url);const path=url.pathname;
 if(path==='/health'){
  const tables=await all<{name:string}>(env,"SELECT name FROM sqlite_master WHERE type='table' AND name IN ('ai_attempts','discovery_batches','products','app_notifications')");
  const ready=tables.length===4;return json({ok:ready,service:'prepyr-outreach',schemaReady:ready,...(!ready?{code:'SCHEMA_REQUIRED',error:'Database migrations must be applied before this release can run'}:{})},ready?200:503);
 }
 if(path==='/unsubscribe') {
  const productId=url.searchParams.get('product');if(productId)env=await scopeProduct(env,await product(env,productId));
  const id=url.searchParams.get('id')||'',sig=url.searchParams.get('sig')||'';
  if(!env.SESSION_SECRET||!sameSecret(sig,await signature(env,'unsubscribe:'+(env.PRODUCT_ID?env.PRODUCT_ID+':':'')+id)))return new Response('Invalid unsubscribe link',{status:400});
  const lead=await one<Lead>(env,'SELECT * FROM leads WHERE id=?',id);if(!lead)return new Response('Address not found',{status:404});
  if(request.method==='POST'){await suppress(env,lead,'Recipient unsubscribe');return new Response('You have been unsubscribed from outreach.');}
  return new Response('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Unsubscribe | Relay</title><body><main><h1>Stop outreach emails</h1><p>Confirm below to stop future outreach.</p><form method="post"><button type="submit">Unsubscribe</button></form></main></body></html>',{headers:{'Content-Type':'text/html'}});
 }
 if(!path.startsWith('/api/'))return env.ASSETS.fetch(request);
 if(request.method==='POST'&&!csrf(request))return json({error:'Request origin could not be verified'},403);
 if(path==='/api/login'&&request.method==='POST'){
  try{const input=await body(request);return json({ok:true},200,{'Set-Cookie':await login(request,env,String(input.password||''))});}catch(e){return json({error:e instanceof Error?e.message:'Login failed'},e instanceof AuthUnavailable?503:401);}
 }
 if(!await authenticated(request,env))return json({error:'Sign in to continue'},401);
 if(path==='/api/session'&&request.method==='GET')return json({authenticated:true});
 if(path==='/api/logout'&&request.method==='POST')return json({ok:true},200,{'Set-Cookie':await logout(request,env)});
 if(path==='/api/notifications'&&request.method==='GET')return json(await notificationPage(env));
 if(path==='/api/notifications/read'&&request.method==='POST'){try{return json(await readNotifications(env,await body(request)));}catch(e){if(isD1Unavailable(e))throw e;return json({error:e instanceof Error?e.message:'Notification update failed'},400);}}
 if(path==='/api/outreach/control'&&request.method==='POST'){try{return json(await controlOutreach(env,await body(request)));}catch(e){if(isD1Unavailable(e))throw e;return json({error:e instanceof Error?e.message:'Program control failed'},400);}}
 if(path==='/api/products'&&request.method==='GET')return json({products:await productList(env)});
 if(path==='/api/products'&&request.method==='POST'){try{return json({product:await saveProduct(env,await body(request,2400000))});}catch(e){return json({error:e instanceof Error?e.message:'Product could not be saved'},400);}}
 const productRoute=path.match(/^\/api\/products\/([a-zA-Z0-9-]+)(?:\/(analyze|approve|run|sender|pause|archive))?$/);
 if(productRoute){
  const [,id,action]=productRoute;
  if(request.method==='GET'&&!action)return json(await productDetail(env,id));
  if(request.method!=='POST')return json({error:'Not found'},404);
  try{
   const input=await body(request,2400000);
   if(['analyze','run','approve'].includes(action||''))await assertOutreachRunning(env);
   if(!action)return json({product:await saveProduct(env,input,id)});
   if(action==='analyze')return json(await queueProductAnalysis(env,id,input.confirmPaidRetry===true));
   if(action==='approve'){if(input.profileReviewed!==true)throw new Error('Review the proposed customer profile before approval');return json(await approveProduct(env,id,Number(input.revision)));}
   if(action==='run'){const p=await product(env,id);if(p.state!=='analyzing')throw new Error('No product research is queued');await advanceProductAnalysis(env,p);return json(await productDetail(env,id));}
   if(action==='sender'){const p=await product(env,id),data=await gmail(env,'settings/sendAs');return json({sender:p.sender_email,accepted:!!data.sendAs?.some((s:any)=>s.sendAsEmail.toLowerCase()===p.sender_email.toLowerCase()&&s.verificationStatus==='accepted'),message:'Product sender must be an accepted send-as identity in the connected Gmail mailbox'});}
   if(action==='pause'){if(typeof input.enabled!=='boolean')throw new Error('Choose whether this product is enabled');await run(env,'UPDATE products SET enabled=?,updated_at=? WHERE id=?',input.enabled?1:0,now(),id);return json({ok:true});}
   if(action==='archive'){if(input.confirm!==true)throw new Error('Confirm product archival; its history is retained');await run(env,"UPDATE products SET enabled=0,state='archived',updated_at=? WHERE id=?",now(),id);return json({ok:true});}
  }catch(e){return json({error:e instanceof Error?e.message:'Product action failed'},400);}
 }
 const selectedProduct=url.searchParams.get('product');
 if(selectedProduct){try{env=await scopeProduct(env,await product(env,selectedProduct));}catch(e){return json({error:e instanceof Error?e.message:'Product not found'},404);}}
 if(path==='/api/workspace-backup/status'&&request.method==='GET')return json({snapshot:await backupStatus(env)});
 if(path==='/api/workspace-backup/import'&&request.method==='POST')return forwardBackupImport(env,request);
 if(request.method==='GET'&&isWorkspaceRead(path)){
  try{return await readWorkspace(request,env);}
  catch(e){
   if(!isD1Unavailable(e))throw e;
   const saved=await savedWorkspace(env);if(!saved)throw e;
   const response=await readWorkspace(request,saved.env,true);const value=await response.json() as any;
   return json({...value,availability:{readOnly:true,source:'saved-copy',capturedAt:saved.info.capturedAt,digest:saved.info.digest}},response.status,{'X-Relay-Data-Mode':'saved-copy'});
  }
 }
 // Keep manual runs attached to the request. Long research must not be cut off
 // by the post-response waitUntil lifetime; unattended work uses cron events.
 if(path==='/api/tick'&&request.method==='POST'){const result=await tick(env);return json({ok:true,message:result?.busy?'A background cycle is already running. Progress refreshes automatically.':'Scheduler cycle finished. Check prospects, drafts and Activity for results.'});}
 if(request.method!=='POST')return json({error:'Not found'},404);
 const lock=await acquire(env,'engine',840);if(!lock)return json({error:'A background task is running. Try again shortly.'},409);
 try{return json(await mutate(request,env,path,await body(request)));}catch(e){if(isD1Unavailable(e))throw e;return json({error:e instanceof Error?e.message:'Action failed'},400);}finally{await release(env,'engine',lock);}
}
export default {
 async fetch(request:Request,env:Env,ctx:ExecutionContext) {
  let response:Response;
  try{response=await route(request,env,ctx);}catch(e){
   if(e instanceof AuthUnavailable)response=json({error:e.message,code:'AUTH_UNAVAILABLE'},503);
   else if(/no such (?:table|column)|has no column named/i.test(e instanceof Error?e.message:''))response=json({error:'Relay needs a database schema update. Deployment was not completed; existing records are preserved.',code:'SCHEMA_REQUIRED'},503);
   else if(isDatabaseLimit(e)) {
    const reset=new Date();reset.setUTCHours(24,0,0,0);
    response=json({error:'Workspace data is temporarily unavailable because the database daily limit has been reached. It resets at 05:30 IST (00:00 UTC). You can stay signed in and refresh after the reset.',code:'DATABASE_DAILY_LIMIT',resetAt:reset.toISOString()},503,{'Retry-After':String(Math.ceil((reset.getTime()-Date.now())/1000))});
   }else response=json({error:'The request could not be completed. Check server configuration and database migrations.'},500);
  }
  const headers=new Headers(response.headers);
  headers.set('X-Content-Type-Options','nosniff');headers.set('X-Frame-Options','DENY');headers.set('Referrer-Policy','no-referrer');
  headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  headers.set('Cache-Control','no-store');headers.set('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  if(new URL(request.url).protocol==='https:')headers.set('Strict-Transport-Security','max-age=31536000');
  return new Response(response.body,{status:response.status,headers});
 },
 async scheduled(_event:ScheduledController,env:Env,ctx:ExecutionContext){ctx.waitUntil((async()=>{try{await tickWorkspaces(env);}finally{await refreshBackup(env);}})());}
};
