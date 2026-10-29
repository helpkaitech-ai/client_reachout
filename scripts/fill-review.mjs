import {readEnv} from './env.mjs';
const e=readEnv(),origin=e.APP_URL,headers={Origin:origin,'X-Requested-With':'Prepyr','Content-Type':'application/json'};
const login=await fetch(origin+'/api/login',{method:'POST',headers,body:JSON.stringify({password:e.ADMIN_PASSWORD})});
if(!login.ok)throw new Error('Sign-in failed');headers.Cookie=login.headers.get('set-cookie').split(';')[0];
try{
 for(let cycle=0;cycle<65;cycle++){
  const r=await fetch(origin+'/api/dashboard',{headers});if(!r.ok)throw new Error('Dashboard HTTP '+r.status);const d=await r.json();
  if(d.connections.sendingEnabled)throw new Error('This verification helper requires sending disabled');
  const count=d.drafts.filter(x=>x.status==='pending'&&!x.quality_hold&&x.email).length;
  console.log(JSON.stringify({cycle,researchedDraftsWithRecipient:count,totalDrafts:d.drafts.length,target:20,jobs:d.jobs.filter(j=>j.state==='pending').length,failed:d.jobs.filter(j=>j.state==='failed').map(j=>({kind:j.kind,error:j.error}))}));
  if(count>=20)break;
  const tick=await fetch(origin+'/api/tick',{method:'POST',headers,body:'{}',signal:AbortSignal.timeout(280000)});if(!tick.ok)throw new Error('Scheduler HTTP '+tick.status);
  const result=await tick.json();if(result.message?.includes('already running'))await new Promise(r=>setTimeout(r,10000));
 }
}finally{await fetch(origin+'/api/logout',{method:'POST',headers,body:'{}'});}
