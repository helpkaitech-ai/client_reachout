import fs from 'node:fs';
import {readEnv} from './env.mjs';
import {offerContext,offerVersion,linkedIn,introduction} from '../src/offers.ts';
const e=readEnv(),base=e.APP_URL,headers={Origin:base,'X-Requested-With':'Prepyr','Content-Type':'application/json'};
const login=await fetch(base+'/api/login',{method:'POST',headers,body:JSON.stringify({password:e.ADMIN_PASSWORD})});if(!login.ok)throw Error('Login failed');headers.Cookie=login.headers.get('set-cookie').split(';')[0];
const recordFile='artifacts/pilot-refresh-run.json';
async function api(path,payload){const r=await fetch(base+path,{method:payload===undefined?'GET':'POST',headers,...(payload===undefined?{}:{body:JSON.stringify(payload)}),signal:AbortSignal.timeout(280000)});const value=await r.json();if(!r.ok)throw Error(value.error||'HTTP '+r.status);return value;}
try{
 let d=await api('/api/dashboard');
 if(process.argv.includes('--queue')){
  const pending=d.drafts.filter(x=>x.status==='pending'&&x.kind==='initial'&&JSON.parse(x.free_offer||'{}').version!==offerVersion);
  const unsupported=pending.filter(x=>x.quality_hold&&JSON.parse(x.evidence||'[]').filter(e=>e.kind==='observed').length===0);
  const targets=pending.filter(x=>!unsupported.includes(x));
  if(fs.existsSync(recordFile)&&targets.length)throw Error('Existing run record found. Inspect before scheduling another run.');
  const record={startedAt:new Date().toISOString(),originalResearchLimit:d.settings.dailyResearchLimit,unsupported:unsupported.map(x=>({id:x.id,company:x.company})),targets:targets.map(x=>({id:x.id,version:x.version,company:x.company}))};
  fs.writeFileSync('artifacts/before-pilot-refresh.json',JSON.stringify({drafts:targets,settings:d.settings},null,2));fs.writeFileSync(recordFile,JSON.stringify(record,null,2));
  const needed=(d.usage?.research_slots||0)+targets.length;
  if(needed>100)throw Error('Daily research limit would exceed 100; preserve queued work for the next day.');
  await api('/api/settings/preferences',{...d.settings,offerContext,portfolio:`Sender background supplied by Rushi: more than 12 years building software; currently works at Adobe. Outreach is independent work, not an Adobe offer. LinkedIn: ${linkedIn}. No case studies, revenue claims or named clients supplied.`,dailyResearchLimit:Math.max(d.settings.dailyResearchLimit,needed)});
  for(const x of unsupported){const lead=d.leads.find(l=>l.id===x.lead_id);await api(`/api/drafts/${x.id}/edit`,{version:x.version,subject:x.subject,body:`Hi ${lead.contact_name||lead.company+' team'},\n\n${introduction(d.settings.senderName)}\n\n[Research incomplete: verify this business's services before proposing a specific working pilot. This draft remains blocked from sending.]`,artifact:''});}
  for(const x of targets)await api(`/api/drafts/${x.id}/rewrite`,{version:x.version});
  console.log(JSON.stringify({queued:targets.length,unsupported:record.unsupported,researchSlotsAlreadyUsed:d.usage?.research_slots,monthlyBudget:d.settings.openaiBudget}));
 }
 if(process.argv.includes('--work')){
  const record=JSON.parse(fs.readFileSync(recordFile,'utf8'));
  for(let cycle=0;cycle<80;cycle++){
   d=await api('/api/dashboard');
   const remaining=record.targets.filter(t=>d.drafts.some(x=>x.id===t.id&&x.version===t.version&&x.status==='pending'));
   const failures=d.jobs.filter(j=>j.kind==='rewrite'&&['failed','uncertain'].includes(j.state));
   console.log(JSON.stringify({cycle,remaining:remaining.length,rewritten:record.targets.length-remaining.length,failures:failures.map(j=>({company:j.company,error:j.error})),openaiCost:d.budgets.find(b=>b.provider==='openai')?.committed}));
   if(!remaining.length)break;
   if(failures.length&&!d.jobs.some(j=>j.kind==='rewrite'&&['pending','running'].includes(j.state)))break;
   if(d.drafts.some(x=>['approved','sending','uncertain'].includes(x.status)))throw Error('A prospect dispatch is active; allow the regular scheduler to proceed. Maintenance will not invoke sending.');
   const result=await api('/api/tick',{});if(result.message?.includes('already running'))await new Promise(r=>setTimeout(r,10000));
  }
  d=await api('/api/dashboard');
  if(record.targets.every(t=>d.drafts.some(x=>x.id===t.id&&x.version>t.version))&&d.settings.dailyResearchLimit!==record.originalResearchLimit)await api('/api/settings/preferences',{...d.settings,dailyResearchLimit:record.originalResearchLimit});
 }
 d=await api('/api/dashboard');fs.writeFileSync('artifacts/after-pilot-refresh.json',JSON.stringify({drafts:d.drafts,leads:d.leads,jobs:d.jobs,budgets:d.budgets},null,2));
 console.log(JSON.stringify({drafts:d.drafts.length,pilots:d.drafts.filter(x=>JSON.parse(x.free_offer||'{}').version===offerVersion).length,holds:d.drafts.filter(x=>x.quality_hold).map(x=>({company:x.company,reason:x.quality_hold})),researchSlots:d.usage?.research_slots,researchLimit:d.settings.dailyResearchLimit,sent:d.metrics.sent}));
}finally{await api('/api/logout',{});}
