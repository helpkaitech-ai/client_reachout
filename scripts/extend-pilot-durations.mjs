import fs from 'node:fs';
import assert from 'node:assert/strict';
import {readEnv} from './env.mjs';
import {offerContext,offerVersion,workingPilotProblem,linkedIn} from '../src/offers.ts';
import {durationFor,extendText} from './pilot-duration-plan.mjs';
const e=readEnv(),base=e.APP_URL,headers={Origin:base,'X-Requested-With':'Prepyr','Content-Type':'application/json'};
const r=await fetch(base+'/api/login',{method:'POST',headers,body:JSON.stringify({password:e.ADMIN_PASSWORD})});assert.equal(r.status,200);headers.Cookie=r.headers.get('set-cookie').split(';')[0];
async function api(path,payload){const response=await fetch(base+path,{method:payload===undefined?'GET':'POST',headers,...(payload===undefined?{}:{body:JSON.stringify(payload)})});assert.equal(response.status,200);return response.json();}
try{
 const d=await api('/api/dashboard');
 if(process.argv.includes('--prepare')){
  const targets=d.drafts.filter(x=>x.status==='pending'&&x.kind==='initial'&&JSON.parse(x.free_offer||'{}').type==='working_pilot'&&JSON.parse(x.free_offer).durationDays<30);
  const plans=targets.map(x=>{
   const old=JSON.parse(x.free_offer),{days,reason}=durationFor(x.company,old,x.body),replace=t=>extendText(t,old.durationDays,days);
   const offer=Object.fromEntries(Object.entries(old).map(([k,v])=>[k,typeof v==='string'&&!['sourceUrl','businessDetail'].includes(k)?replace(v):v]));
   Object.assign(offer,{version:offerVersion,durationDays:days,durationReason:reason});
   const body=replace(x.body),subject=replace(x.subject),content=body.slice(body.indexOf(linkedIn)+linkedIn.length).trim();
   assert.equal(workingPilotProblem({body:content,freeOffer:offer}),'',x.company);assert.ok(body.includes(offer.emailExcerpt));
   return {id:x.id,company:x.company,oldVersion:x.version,oldDays:old.durationDays,days,reason,body,subject,offer,qualityHold:x.quality_hold};
  });
  const q=s=>"'"+String(s).replaceAll("'","''")+"'",stamp=new Date().toISOString();
  const sql=plans.map(p=>`UPDATE drafts SET subject=${q(p.subject)},body=${q(p.body)},free_offer=${q(JSON.stringify(p.offer))},version=version+1,approved_hash=NULL,approved_version=NULL,approved_at=NULL,updated_at=${q(stamp)} WHERE id=${q(p.id)} AND version=${p.oldVersion} AND status='pending';`).join('\n');
  fs.writeFileSync('artifacts/pilot-duration-before.json',JSON.stringify({drafts:targets,settings:d.settings},null,2));
  fs.writeFileSync('artifacts/pilot-duration-plan.json',JSON.stringify(plans,null,2));fs.writeFileSync('artifacts/extend-pilot-durations.sql',sql);
  console.log(JSON.stringify({prepared:plans.length,periods:plans.reduce((a,p)=>(a[p.days]=(a[p.days]||0)+1,a),{})}));
 }
 if(process.argv.includes('--settings'))await api('/api/settings/preferences',{...d.settings,offerContext});
 if(process.argv.includes('--verify')){
  const plans=JSON.parse(fs.readFileSync('artifacts/pilot-duration-plan.json','utf8'));
  for(const p of plans){const x=d.drafts.find(x=>x.id===p.id);assert.equal(x.version,p.oldVersion+1);assert.equal(x.subject,p.subject);assert.equal(x.body,p.body);assert.deepEqual(JSON.parse(x.free_offer),p.offer);assert.equal(x.quality_hold,p.qualityHold);assert.equal(x.status,'pending');assert.equal(x.approved_hash,null);}
  assert.ok(d.settings.offerContext.includes('30, 45 or 60'));assert.equal(d.metrics.sent,0);
  for(const days of [30,45,60]){const p=plans.find(p=>p.days===days);const preview=await api(`/api/drafts/${p.id}/preview`);assert.ok(preview.body.includes(`${days}-day`));assert.ok(preview.body.includes(d.settings.businessAddress));assert.ok(preview.from.includes(d.connections.sender));}
  const remaining=d.drafts.filter(x=>['pending','approved','failed'].includes(x.status)&&/\b(?:7|10|14)[-– ]day\b|\bafter (?:7|10|14) days\b|\bday (?:7|10|14)\b/i.test(x.subject+' '+x.body));assert.equal(remaining.length,0,'Short pilot text remains');
  const report={checkedAt:new Date().toISOString(),checked:plans.length,periods:plans.reduce((a,p)=>(a[p.days]=(a[p.days]||0)+1,a),{}),noShortPilots:true,noEmailsSent:true};
  fs.writeFileSync('artifacts/pilot-duration-validation.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 }
}finally{await api('/api/logout',{});}
