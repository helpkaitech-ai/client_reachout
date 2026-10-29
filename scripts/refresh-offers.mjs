import fs from 'node:fs';
import {readEnv} from './env.mjs';
const e=readEnv(),base=e.APP_URL,headers={Origin:base,'X-Requested-With':'Prepyr','Content-Type':'application/json'};
const login=await fetch(base+'/api/login',{method:'POST',headers,body:JSON.stringify({password:e.ADMIN_PASSWORD})});if(!login.ok)throw Error('Login failed');headers.Cookie=login.headers.get('set-cookie').split(';')[0];
const file='artifacts/offer-rewrite-run.json';
async function api(path,payload){const r=await fetch(base+path,{method:payload===undefined?'GET':'POST',headers,...(payload===undefined?{}:{body:JSON.stringify(payload)}),signal:AbortSignal.timeout(280000)});const value=await r.json();if(!r.ok)throw Error(value.error||'HTTP '+r.status);return value;}
try{
 let d=await api('/api/dashboard');if(d.connections.sendingEnabled)throw Error('This maintenance run requires sending paused');
 if(process.argv.includes('--queue')){
  const targets=d.drafts.filter(x=>x.status==='pending'&&x.kind==='initial'&&!JSON.parse(x.free_offer||'{}').emailExcerpt);
  const record={startedAt:new Date().toISOString(),originalResearchLimit:d.settings.dailyResearchLimit,targets:targets.map(x=>({id:x.id,version:x.version,company:x.company}))};
  fs.writeFileSync('artifacts/before-offer-refresh.json',JSON.stringify({drafts:targets,settings:d.settings},null,2));fs.writeFileSync(file,JSON.stringify(record,null,2));
  const needed=Math.min(100,(d.usage?.research_slots||0)+targets.length+2);if(needed>d.settings.dailyResearchLimit)await api('/api/settings',{...d.settings,dailyResearchLimit:needed});
  for(const x of targets)await api(`/api/drafts/${x.id}/rewrite`,{version:x.version});
  console.log(JSON.stringify({queued:targets.length,activeLocations:d.settings.campaigns.filter(c=>c.enabled).map(c=>c.location)}));
 }
 if(process.argv.includes('--work')){
  const record=JSON.parse(fs.readFileSync(file,'utf8'));
  for(let cycle=0;cycle<80;cycle++){
   d=await api('/api/dashboard');const remaining=record.targets.filter(t=>d.drafts.some(x=>x.id===t.id&&x.version===t.version&&x.status==='pending'));
   const failed=d.jobs.filter(j=>j.kind==='rewrite'&&['failed','uncertain'].includes(j.state));
   console.log(JSON.stringify({cycle,remaining:remaining.length,rewritten:record.targets.length-remaining.length,failed:failed.map(j=>({company:j.company,error:j.error})),budget:d.budgets.find(b=>b.provider==='openai')?.committed}));
   if(!remaining.length||failed.length){if(!remaining.length&&d.settings.dailyResearchLimit!==record.originalResearchLimit)await api('/api/settings',{...d.settings,dailyResearchLimit:record.originalResearchLimit});break;}
   const result=await api('/api/tick',{});if(result.message?.includes('already running'))await new Promise(r=>setTimeout(r,10000));
  }
 }
 d=await api('/api/dashboard');fs.writeFileSync('artifacts/after-offer-refresh.json',JSON.stringify({drafts:d.drafts,leads:d.leads,jobs:d.jobs,budgets:d.budgets},null,2));
 console.log(JSON.stringify({drafts:d.drafts.length,withOffer:d.drafts.filter(x=>JSON.parse(x.free_offer||'{}').emailExcerpt).length,holds:d.drafts.filter(x=>x.quality_hold).length,sent:d.metrics.sent}));
}finally{await api('/api/logout',{});}
