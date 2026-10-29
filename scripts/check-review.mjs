import { readEnv } from './env.mjs';
const e=readEnv(),base=e.APP_URL;
const headers={Origin:base,'X-Requested-With':'Prepyr','Content-Type':'application/json'};
const login=await fetch(base+'/api/login',{method:'POST',headers,body:JSON.stringify({password:e.ADMIN_PASSWORD})});
if(!login.ok)throw new Error('Login failed '+login.status);
headers.Cookie=login.headers.get('set-cookie').split(';')[0];
try{
 if(process.argv.includes('--finish-contacts'))for(let i=0;i<6;i++){
  const r=await fetch(base+'/api/dashboard',{headers});if(!r.ok)throw new Error('Dashboard failed');const d=await r.json();
  if(d.connections.sendingEnabled)throw new Error('Diagnostic run requires sending disabled');
  if(!d.jobs.some(j=>j.kind==='contact'&&j.state==='pending'))break;
  const t=await fetch(base+'/api/tick',{method:'POST',headers,body:'{}'});if(!t.ok)throw new Error('Scheduler failed');const result=await t.json();
  if(result.message?.includes('already running'))break;
 }
 if(process.argv.includes('--tick')){const r=await fetch(base+'/api/tick',{method:'POST',headers,body:'{}'});console.log('Scheduler:',r.status,await r.text());}
 const r=await fetch(base+'/api/dashboard',{headers});if(!r.ok)throw new Error('Dashboard failed');const d=await r.json();
 console.log(JSON.stringify({prospects:d.leads.length,drafts:d.drafts.length,unresearched:d.leads.filter(l=>!d.drafts.some(x=>x.lead_id===l.id)).map(l=>({company:l.company,status:l.status})),verification:d.leads.reduce((a,l)=>(a[l.verification]=(a[l.verification]||0)+1,a),{}),northern:d.leads.filter(l=>/northern/i.test(l.company)).map(l=>({company:l.company,email:l.email,verification:l.verification,note:l.verification_note})),jobs:d.jobs.filter(j=>j.state!=='complete').map(j=>({kind:j.kind,state:j.state,error:j.error,company:j.company})),metrics:d.metrics,budgets:d.budgets,sending:d.connections.sendingEnabled},null,2));
}finally{await fetch(base+'/api/logout',{method:'POST',headers,body:'{}'});}
