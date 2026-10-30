import type { Draft, Evidence, Lead, Settings } from './types';
import {defaults as defaultsForSettings} from './types';
import { validateLocations } from './locations';
export function cleanEmail(value:unknown):string|null {
 if(typeof value!=='string') return null;
 const email=value.trim().toLowerCase();
 return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(email)&&email.length<=254 ? email:null;
}
export function publicUrl(value:unknown):string|null {
 try {
  const u=new URL(String(value)); const host=u.hostname.toLowerCase();
  if(!['https:','http:'].includes(u.protocol)||u.username||u.password||u.port) return null;
  if(!host.includes('.')||host.endsWith('.local')||host.endsWith('.internal')||host==='localhost'||/^\d+(\.\d+){3}$/.test(host)||host.includes(':')) return null;
  return u.href;
 } catch{return null;}
}
export function validTimezone(zone:string) { try{new Intl.DateTimeFormat('en',{timeZone:zone}).format();return true;}catch{return false;} }
export function withinWindow(date:Date,timezone:string,s:Settings) {
 if(!validTimezone(timezone)) return false;
 const parts=new Intl.DateTimeFormat('en-US',{timeZone:timezone,hour:'numeric',hourCycle:'h23',weekday:'short'}).formatToParts(date);
 const h=Number(parts.find(p=>p.type==='hour')?.value); const weekday=parts.find(p=>p.type==='weekday')?.value;
 return h>=s.sendStartHour&&h<s.sendEndHour&&(s.sendWeekends||!['Sat','Sun'].includes(weekday||''));
}
export async function digest(value:string) {return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))).map(b=>b.toString(16).padStart(2,'0')).join('');}
export async function approvalHash(d:Draft,l:Lead,s:Settings,sender:string) {
 return digest(JSON.stringify([d.id,d.version,d.subject,d.body,d.artifact,d.kind,d.in_reply_to,l.email,s.senderName,s.businessAddress,sender]));
}
export function approvalProblems(d:Draft,l:Lead,s:Settings):string[] {
 const errors:string[]=[];
 if(!cleanEmail(l.email)) errors.push('A valid recipient email is required');
 if(!['valid','manual','owner_reviewed'].includes(l.verification)) errors.push(l.verification==='invalid'?'Email verification failed; replace this recipient address':'Recipient review is required');
 if(l.eligibility!=='eligible'||!l.eligibility_note.trim()) errors.push('Document the outreach eligibility for this business and country');
 if(l.contact_status==='conflicting')errors.push('Public contact evidence conflicts with the recipient; resolve it in contact review');
 if(['suppressed','bounced','closed'].includes(l.status)) errors.push('This business is blocked from outreach');
 if(d.kind==='followup'&&(l.last_inbound_at||!l.next_followup_at||l.followup_count>=Math.min(3,s.followupDays.length)))errors.push('This follow-up sequence has stopped or reached its limit');
 if(!s.businessAddress.trim())errors.push('Sending activation requires a valid business postal address or qualifying mailbox in Settings');
 if(d.quality_hold)errors.push(d.quality_hold);
 if(!d.subject.trim()||d.subject.length>180||/[\r\n]/.test(d.subject)) errors.push('Use a single-line subject of 1–180 characters');
 if(d.body.trim().length<30) errors.push('The message is too short');
 const evidence:Evidence[]=JSON.parse(d.evidence||'[]');
 if(d.kind==='initial'&&evidence.filter(e=>e.kind==='observed'&&publicUrl(e.url)).length<2) errors.push('At least two sourced observations are required');
 if(d.kind==='initial'&&(!l.research_at||Date.now()-Date.parse(l.research_at)>30*86400000)) errors.push('Research is missing or older than 30 days');
 return errors;
}
export function classifyInbound(text:string,headers:Record<string,string>):'optout'|'bounce'|'automatic'|'reply' {
 if(/mailer-daemon|postmaster/i.test(headers.from||'')||/multipart\/report/i.test(headers['content-type']||'')) return 'bounce';
 if((headers['auto-submitted']&&headers['auto-submitted']!=='no')||/auto.?reply|out of office/i.test(headers.subject||'')) return 'automatic';
 // Only the new portion of the reply, not a quoted unsubscribe footer.
 const fresh=text.split(/\n(?:On .+wrote:|From:|>|_{5,}|-{5,}Original Message)/i)[0].slice(0,5000);
 return /\bunsubscribe\b|\bremove me\b|\bstop (?:emailing|contacting|sending)\b|\bdo not contact\b|\bnot interested\b/i.test(fresh)?'optout':'reply';
}
export function validateSettings(input:unknown):Settings {
 const s=input as Settings;
 if(!s||typeof s!=='object') throw new Error('Settings must be an object');
 if(s.locationIds!==undefined)s.locationIds=validateLocations(s.locationIds);
 for(const [key,max] of Object.entries({dailyNewLimit:20,dailyTotalLimit:100,dailyResearchLimit:100,openaiBudget:50,discoveryResults:10,discoveryIntervalDays:30})) {
  const v=s[key as keyof Settings]; if(typeof v!=='number'||!Number.isFinite(v)||v<=0||v>max) throw new Error(`${key} must be >0 and <=${max}`);
 }
 for(const key of ['dailyNewLimit','dailyTotalLimit','dailyResearchLimit','discoveryResults','discoveryIntervalDays'] as const) if(!Number.isInteger(s[key])) throw new Error(`${key} must be an integer`);
 if(!Number.isInteger(s.sendStartHour)||!Number.isInteger(s.sendEndHour)||s.sendStartHour<0||s.sendEndHour>24||s.sendStartHour>=s.sendEndHour) throw new Error('Invalid sending hours');
 if(!Array.isArray(s.followupDays)||s.followupDays.length>3||s.followupDays.some((n,i)=>!Number.isInteger(n)||n<2||n>30||(i>0&&n<=s.followupDays[i-1]))) throw new Error('Use up to three increasing follow-up days, between 2 and 30');
 for(const k of ['senderName','businessAddress','offerContext','portfolio'] as const) if(typeof s[k]!=='string'||s[k].length>8000) throw new Error(`Invalid ${k}`);
 if(/[\r\n<>]/.test(s.senderName)) throw new Error('Invalid sender name');
 if(typeof s.providerPolicyConfirmed!=='boolean'||typeof s.sendWeekends!=='boolean') throw new Error('Invalid settings switches');
 if(s.researchAutomation!==undefined&&typeof s.researchAutomation!=='boolean')throw new Error('Invalid research automation setting');
 for(const key of ['outreachPaused','discoveryPaused'] as const)if(s[key]!==undefined&&typeof s[key]!=='boolean')throw new Error('Invalid pause setting');
 if(s.discoveryPausedUntil!==undefined&&(typeof s.discoveryPausedUntil!=='string'||(s.discoveryPausedUntil!==''&&(!Number.isFinite(Date.parse(s.discoveryPausedUntil))||new Date(s.discoveryPausedUntil).toISOString()!==s.discoveryPausedUntil))))throw new Error('Invalid discovery pause date');
 if(!Array.isArray(s.campaigns)||s.campaigns.length>30) throw new Error('Use up to 30 campaigns');
 for(const c of s.campaigns) if(!c||typeof c.query!=='string'||typeof c.location!=='string'||!c.query.trim()||!c.location.trim()||c.query.length>150||c.location.length>150||!/^[A-Z]{2}$/.test(c.country)||!validTimezone(c.timezone)||typeof c.enabled!=='boolean') throw new Error('Invalid campaign');
 const clean={...s};for(const k of Object.keys(clean))if(!(k in defaultsForSettings))delete (clean as any)[k];
 return clean;
}
