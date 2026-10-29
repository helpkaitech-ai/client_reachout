import { readEnv } from './env.mjs';
const e=readEnv(),origin=e.APP_URL;
const headers={Origin:origin,'X-Requested-With':'Prepyr','Content-Type':'application/json'};
const login=await fetch(origin+'/api/login',{method:'POST',headers,body:JSON.stringify({password:e.ADMIN_PASSWORD})});
if(!login.ok)throw new Error('Hosted login failed: '+login.status);
headers.Cookie=login.headers.get('set-cookie').split(';')[0];
try {
 const action=process.argv[2]?.startsWith('/api/')?process.argv[2]:null;
 if(action){const payload=process.argv[3]?.startsWith('--')?'{}':process.argv[3]||'{}';const r=await fetch(origin+action,{method:'POST',headers,body:payload});console.log(JSON.stringify({action,status:r.status,result:await r.json()}));}
 const r=await fetch(origin+'/api/dashboard',{headers});if(!r.ok)throw new Error('Dashboard HTTP '+r.status);
 const d=await r.json();
 if(process.argv.includes('--summary'))console.log(JSON.stringify({connections:d.connections,prospects:d.leads.length,withEmail:d.leads.filter(l=>l.email).length,withPhone:d.leads.filter(l=>l.phone).length,stats:d.stats,budgets:d.budgets,drafts:d.drafts.map(x=>({company:x.company,status:x.status,subject:x.subject,body:x.body,evidence:JSON.parse(x.evidence)})),jobs:d.jobs.map(j=>({company:j.company,state:j.state,error:j.error})),notifications:d.notifications,events:d.events.slice(0,5)},null,2));
 else console.log(JSON.stringify({connections:d.connections,settings:d.settings,stats:d.stats,usage:d.usage,budgets:d.budgets,leads:d.leads.map(l=>({id:l.id,company:l.company,website:l.website,email:l.email,phone:l.phone,status:l.status,opportunity:l.opportunity})),drafts:d.drafts.map(x=>({id:x.id,company:x.company,status:x.status,subject:x.subject})),jobs:d.jobs,runs:d.runs,events:d.events.slice(0,12)},null,2));
} finally {await fetch(origin+'/api/logout',{method:'POST',headers,body:'{}'});}
