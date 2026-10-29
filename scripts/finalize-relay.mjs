import fs from 'node:fs';
import {readEnv} from './env.mjs';
const e=readEnv(),origin=e.APP_URL,headers={Origin:origin,'X-Requested-With':'Prepyr','Content-Type':'application/json'};
const login=await fetch(origin+'/api/login',{method:'POST',headers,body:JSON.stringify({password:e.ADMIN_PASSWORD})});if(!login.ok)throw new Error('Login failed');headers.Cookie=login.headers.get('set-cookie').split(';')[0];
async function api(path,payload){const r=await fetch(origin+path,{method:payload?'POST':'GET',headers,...(payload?{body:JSON.stringify(payload)}:{})});const value=await r.json();if(!r.ok)throw new Error(path+': '+(value.error||r.status));return value;}
try{
 let d=await api('/api/dashboard');if(d.connections.sendingEnabled)throw new Error('This verification requires sending disabled');
 let corrected=0;
 for(const draft of d.drafts.filter(d=>d.status==='pending'&&/^(?:hi|hello|dear|hey)\s+rushi\b/i.test(d.body))){
  const lead=d.leads.find(l=>l.id===draft.lead_id);if(!lead||lead.contact_name?.toLowerCase().startsWith('rushi'))continue;
  const body='Hi '+(lead.contact_name||lead.company+' team')+',\n\n'+draft.body.trim().replace(/^(?:hi|hello|dear|hey)\b[^\n]{0,180}\n+/i,'');
  await api('/api/drafts/'+draft.id+'/edit',{version:draft.version,subject:draft.subject,body,artifact:draft.artifact});corrected++;
 }
 const s=d.settings;if(s.senderName==='Rushi at Prepyr')s.senderName='Rushi Shukla';if(s.discoveryResults===40)s.discoveryResults=80;await api('/api/settings',s);
 d=await api('/api/dashboard');
 const report={time:new Date().toISOString(),url:origin,brand:'Relay',metrics:d.metrics,prospects:d.leads.length,withEmail:d.leads.filter(l=>l.email).length,pendingDrafts:d.drafts.filter(x=>x.status==='pending').length,researchedDraftsWithRecipient:d.drafts.filter(x=>x.status==='pending'&&!x.quality_hold&&x.email).length,qualityHeld:d.drafts.filter(x=>x.quality_hold).length,missingRecipient:d.drafts.filter(x=>!x.email).length,correctedGreetings:corrected,connections:d.connections,budgets:d.budgets,notifications:d.notifications.slice(0,6),jobs:d.jobs.reduce((a,j)=>(a[j.state]=(a[j.state]||0)+1,a),{})};
 fs.writeFileSync('artifacts/relay-release.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await api('/api/logout',{});}
