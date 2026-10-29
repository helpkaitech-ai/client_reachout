import type { Env, Lead } from './types';
import { all, one, settings } from './db';
import { approvalProblems } from './policy';

const records=`WITH rows AS (
 SELECT l.*,d.id draft_id,d.status draft_status,d.kind draft_kind,d.subject draft_subject,d.send_after,(SELECT classification FROM messages WHERE lead_id=l.id AND direction='inbound' ORDER BY created_at DESC,id DESC LIMIT 1) inbound_classification,
 CASE
 WHEN l.status IN ('suppressed','closed','bounced') THEN 'stopped'
 WHEN d.status='uncertain' THEN 'check_sent'
 WHEN d.status='sending' THEN 'sending'
 WHEN d.status='approved' THEN 'scheduled'
 WHEN d.status='failed' THEN 'failed'
 WHEN d.status='pending' AND (l.email IS NULL OR l.verification='invalid' OR l.eligibility='ineligible' OR d.quality_hold<>'') THEN 'attention'
 WHEN d.status='pending' THEN 'pending'
 WHEN l.status='automatic' THEN 'automatic'
 WHEN l.last_inbound_at IS NOT NULL THEN 'replied'
 WHEN l.last_sent_at IS NOT NULL THEN 'sent'
 WHEN d.status IN ('rejected','cancelled') THEN 'not_sent'
 ELSE 'preparing' END email_status
 FROM leads l LEFT JOIN drafts d ON d.id=(SELECT id FROM drafts WHERE lead_id=l.id
 ORDER BY CASE WHEN status IN ('pending','approved','sending','uncertain','failed') THEN 0 WHEN status='sent' THEN 1 ELSE 2 END,created_at DESC,id DESC LIMIT 1)
)`;
const groups:Record<string,string>={
 all:'1=1',pending:"email_status='pending'",attention:"email_status IN ('attention','failed','check_sent')",
 contacted:'last_sent_at IS NOT NULL',replied:"id IN (SELECT lead_id FROM messages WHERE direction='inbound' AND classification='reply')",
 followup:"(status='contacted' OR (draft_kind='followup' AND draft_status='pending')) AND last_inbound_at IS NULL AND (next_followup_at<=datetime('now') OR (draft_kind='followup' AND draft_status='pending'))",
};
// ISO timestamps must be compared with the same format as persisted timestamps.
groups.followup=groups.followup.replace("datetime('now')","strftime('%Y-%m-%dT%H:%M:%fZ','now')");

export async function prospectPage(env:Env,url:URL){
 const group=url.searchParams.get('group')||'all';if(group!=='sent'&&!groups[group])throw new Error('Unknown prospect filter');
 const offset=Math.max(0,Math.floor(Number(url.searchParams.get('offset'))||0)),limit=50;
 const q=(url.searchParams.get('q')||'').slice(0,150).toLowerCase();
 const search="instr(lower(company||' '||coalesce(email,'')||' '||city||' '||country),?)>0";
 const counts=await one(env,`${records} SELECT ${Object.entries(groups).map(([key,where])=>`SUM(CASE WHEN ${where} THEN 1 ELSE 0 END) AS ${key==='all'?'total':key}`).join(',')},(SELECT COUNT(*) FROM drafts WHERE status='sent') sent FROM rows`);
 if(group==='sent'){
  const from="FROM drafts d JOIN leads l ON l.id=d.lead_id WHERE d.status='sent' AND instr(lower(l.company||' '||coalesce(l.email,'')||' '||l.city||' '||l.country),?)>0";
  const result=await all(env,`SELECT l.*,d.id draft_id,d.subject draft_subject,d.kind draft_kind,d.updated_at sent_at,'sent' email_status ${from} ORDER BY d.updated_at DESC,d.id DESC LIMIT ? OFFSET ?`,q,limit,offset);
  const total=await one<{n:number}>(env,`SELECT COUNT(*) n ${from}`,q);
  return {rows:result,counts,total:total?.n||0,offset,hasMore:offset+result.length<(total?.n||0)};
 }
 const where=`${groups[group]} AND ${search}`;
 const result=await all(env,`${records} SELECT * FROM rows WHERE ${where} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`,q,limit,offset);
 const total=await one<{n:number}>(env,`${records} SELECT COUNT(*) n FROM rows WHERE ${where}`,q);
 return {rows:result,counts,total:total?.n||0,offset,hasMore:offset+result.length<(total?.n||0)};
}

export async function prospectDetail(env:Env,id:string){
 const lead=await one<Lead>(env,'SELECT * FROM leads WHERE id=?',id);if(!lead)throw new Error('Prospect not found');
 const s=await settings(env);
 const drafts=(await all<any>(env,'SELECT * FROM drafts WHERE lead_id=? ORDER BY created_at DESC,id DESC',id)).map(d=>({...d,company:lead.company,email:lead.email,sendIssues:approvalProblems(d,{...lead,eligibility:lead.eligibility==='ineligible'?'ineligible':'eligible',eligibility_note:'Owner confirms when sending',verification:lead.verification==='invalid'?'invalid':'owner_reviewed'},s)}));
 return {lead,drafts,messages:await all(env,'SELECT * FROM messages WHERE lead_id=? ORDER BY created_at DESC',id)};
}
