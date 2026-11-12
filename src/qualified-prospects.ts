import {verifiedWorkContact} from './work-email-policy';
import type {Env,Settings,Lead} from './types';
import {one,run,day,now,audit} from './db';
import {cleanEmail,publicUrl} from './policy';

// One predicate is shared by the list, counters, admission limit and cycle goal.
// Sent conversations retain their history even after their research ages.
export function readyDraftSql(product:boolean,l='l',d='d',saved=false){
 return `${d}.status IN ('pending','approved','sending','sent')
 AND ${l}.status NOT IN ('suppressed','closed','bounced','not_qualified')
 AND ${l}.eligibility<>'ineligible' AND ${l}.verification<>'invalid'
 AND instr(coalesce(${l}.email,''),'@')>1 AND coalesce(${d}.quality_hold,'')=''
 AND length(trim(${d}.subject)) BETWEEN 1 AND 180 AND instr(${d}.subject,char(10))=0 AND instr(${d}.subject,char(13))=0
 AND length(trim(${d}.body))>=30
 AND (CASE WHEN json_valid(${d}.evidence) THEN (SELECT COUNT(*) FROM json_each(${d}.evidence) e WHERE CASE WHEN e.type='object' THEN json_extract(e.value,'$.kind')='observed' AND json_extract(e.value,'$.url') LIKE 'http%://%' ELSE 0 END) ELSE 0 END)>=2
 AND (${d}.status='sent' OR (${l}.research_at IS NOT NULL AND ${l}.research_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days')))
 ${product?`AND (CASE WHEN json_valid(${l}.dossier) THEN json_extract(${l}.dossier,'$.qualified') ELSE 0 END)=1
 AND ((${l}.contact_status='provider_verified' AND ${verifiedContactSql(l)}) OR (${l}.contact_status='publicly_sourced'
 AND (CASE WHEN json_valid(${l}.contact_evidence) THEN json_extract(${l}.contact_evidence,'$.identityConfirmed')=1
 AND json_extract(${l}.contact_evidence,'$.evidenceType')='opened_page'
 AND length(coalesce(json_extract(${l}.contact_evidence,'$.sourceUrl'),''))>8
 AND instr(lower(coalesce(json_extract(${l}.contact_evidence,'$.excerpt'),'')),lower(${l}.email))>0 ELSE 0 END)))`:''}
 ${saved?'':`AND NOT EXISTS(SELECT 1 FROM suppressions s WHERE s.email=${l}.email)`}`;
}
export function publicContactReady(lead:Lead){
 let c:any={};try{c=JSON.parse(lead.contact_evidence||'{}');}catch{}
 if(lead.contact_status==='provider_verified')return verifiedWorkContact(c,lead.email,lead.website);
 return !!cleanEmail(lead.email)&&lead.contact_status==='publicly_sourced'&&c.identityConfirmed===true&&c.evidenceType==='opened_page'&&!!publicUrl(c.sourceUrl)&&String(c.excerpt||'').toLowerCase().includes(lead.email!.toLowerCase());
}
export async function rejectCandidate(env:Env,lead:Lead,jobId:string,reason:string,rewrite?:{id:string;version:number}){
 await env.DB.batch([
  env.DB.prepare("UPDATE leads SET status=CASE WHEN last_sent_at IS NULL AND status NOT IN ('suppressed','closed','bounced') THEN 'not_qualified' ELSE status END,updated_at=? WHERE id=?").bind(now(),lead.id),
  env.DB.prepare('INSERT OR REPLACE INTO pipeline_results(job_id,data,created_at) VALUES(?,?,?)').bind(jobId,JSON.stringify({qualified:false,reason}),now()),
  ...(rewrite?[env.DB.prepare("UPDATE drafts SET quality_hold=?,status='rejected',approved_hash=NULL,updated_at=? WHERE id=? AND version=? AND status='pending'").bind(reason,now(),rewrite.id,rewrite.version)]:[])
 ]);
 await audit(env,'candidate_not_qualified',lead.id,reason);
}
export async function qualifiedToday(env:Env){
 return (await one<{n:number}>(env,`SELECT COUNT(DISTINCT lower(l.email)) n FROM qualified_prospects q JOIN drafts d ON d.id=q.draft_id JOIN leads l ON l.id=q.lead_id WHERE q.admitted_at>=? AND d.kind='initial' AND ${readyDraftSql(!!env.PRODUCT_ID)}`,day()+'T00:00:00.000Z'))?.n||0;
}
export async function admissionAvailable(env:Env,s:Settings,leadId:string){
 if(await one(env,'SELECT lead_id FROM qualified_prospects WHERE lead_id=?',leadId))return true;
 return await qualifiedToday(env)<s.dailyLeadLimit;
}
export async function recordAdmission(env:Env,leadId:string,draftId:string){
 await run(env,'INSERT OR IGNORE INTO qualified_prospects(lead_id,draft_id,admitted_at) VALUES(?,?,?)',leadId,draftId,now());
}
export async function backfillAdmissions(env:Env){
 await run(env,`INSERT OR IGNORE INTO qualified_prospects(lead_id,draft_id,admitted_at)
 SELECT l.id,d.id,d.created_at FROM leads l JOIN drafts d ON d.lead_id=l.id WHERE d.kind='initial' AND ${readyDraftSql(!!env.PRODUCT_ID)} ORDER BY d.created_at,d.id`);
}

function verifiedContactSql(l:string){
 const j=(path:string)=>`json_extract(${l}.contact_evidence,'$.${path}')`;
 return `(CASE WHEN json_valid(${l}.contact_evidence) THEN ${j('status')}='provider_verified'
 AND ${j('email')}=${l}.email AND ${j('companyDomain')}=${l}.domain
 AND (substr(${l}.email,instr(${l}.email,'@')+1)=${l}.domain OR substr(${l}.email,instr(${l}.email,'@')+1) LIKE '%.'||${l}.domain)
 AND ${j('identityConfirmed')}=1 AND ${j('evidenceType')}='provider_verification'
 AND ${j('provider')}='apify/thirdwatch-email-verifier'
 AND ${j('verification.email')}=${l}.email AND ${j('verification.status')}='good'
 AND ${j('verification.technical_status')}='valid' AND ${j('verification.reason')}='ok'
 AND ${j('verification.free')}=0 AND ${j('verification.role')}=0 AND ${j('verification.disposable')}=0
 AND ${j('verification.catch_all')}=0 AND ${j('verification.mailInfrastructureFound')}=1
 AND length(${j('verificationRunId')})>0 AND ${j('verificationRunId')} NOT GLOB '*[^a-zA-Z0-9]*'
 AND length(${j('enrichmentRunId')})>0 AND ${j('enrichmentRunId')} NOT GLOB '*[^a-zA-Z0-9]*'
 AND (${j('profileUrl')} LIKE 'https://linkedin.com/in/%' OR ${j('profileUrl')} LIKE 'https://www.linkedin.com/in/%' OR ${j('profileUrl')} GLOB 'https://[a-z][a-z].linkedin.com/in/*')
 AND datetime(${j('observedAt')}) BETWEEN datetime('now','-30 days') AND datetime('now','+5 minutes')
 ELSE 0 END)`;
}
