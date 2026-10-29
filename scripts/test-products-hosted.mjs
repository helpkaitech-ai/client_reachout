import fs from 'node:fs';
import {readEnv} from './env.mjs';
const e=readEnv(),origin=e.APP_URL,path='artifacts/products-live-validation.json',phase=process.argv.find(x=>x.startsWith('--phase='))?.split('=')[1];
if(!['profile','outreach','cleanup'].includes(phase))throw Error('Choose --phase=profile, --phase=outreach --profile-reviewed, or --phase=cleanup');
const report=fs.existsSync(path)?JSON.parse(fs.readFileSync(path,'utf8')):{startedAt:new Date().toISOString(),status:'running',prospectEmailsSent:0};
const headers={Origin:origin,'X-Requested-With':'Prepyr','Content-Type':'application/json'};
const login=await fetch(origin+'/api/login',{method:'POST',headers,body:JSON.stringify({password:e.ADMIN_PASSWORD})});if(!login.ok)throw Error('Login HTTP '+login.status);headers.Cookie=login.headers.get('set-cookie').split(';')[0];
function save(){fs.writeFileSync(path,JSON.stringify(report,null,2));}
async function api(p,data){const r=await fetch(origin+p,{headers,...(data===undefined?{}:{method:'POST',body:JSON.stringify(data)}),signal:AbortSignal.timeout(150000)});const d=await r.json();if(!r.ok)throw Error(p+': '+(d.error||r.status));if(d.availability?.readOnly)throw Error('Validation received a saved copy instead of live records');return d;}
try{
 if(phase==='profile'){
  if(!report.productId){
   const image=fs.readFileSync('output/playwright/products-target-review-desktop.png').toString('base64');
   const created=await api('/api/products',{name:'Relay deployment verification',website:origin,description:'Relay is a single-owner B2B outreach application. It discovers businesses, researches public business facts and emails with OpenAI, prepares personalized product-specific emails, and lets the owner edit and approve each email before Gmail sending. Products have separate workspaces, senders, budgets and daily limits. The screenshot shows the real interface with fictional sample product data, not real customer results. No pricing, free trial or sales results are promised.',remarks:'For this verification, target independent B2B software consultancies in Bengaluru, India, offering custom software development and publishing a public business email. Focus on improving careful prospect research and first-email preparation for their own services. Exclude mass marketing agencies and directories. In emails mention owner-controlled review and a low-pressure product walkthrough; never promise free work, trials, revenue or implementation services.',sender_email:e.SENDER_EMAIL,images:[{name:'Relay product workspace example',data:'data:image/png;base64,'+image}]});
   report.productId=created.product.id;save();
   await api('/api/products/'+report.productId+'/pause',{enabled:false});
   const d=await api('/api/dashboard?product='+report.productId+'&summary=1');
   await api('/api/settings/preferences?product='+report.productId,{...d.settings,openaiBudget:2,dailyResearchLimit:2,dailyNewLimit:1,dailyTotalLimit:1,discoveryResults:2,discoveryIntervalDays:30});
  }
  let d=await api('/api/products/'+report.productId);
  if(d.product.state==='draft')await api('/api/products/'+report.productId+'/analyze',{});
  for(let step=0;step<5;step++){
   d=await api('/api/products/'+report.productId);if(d.product.state!=='analyzing')break;
   d=await api('/api/products/'+report.productId+'/run',{});report.profileState=d.product.state;report.committedUsd=d.budget.committed;save();console.log(JSON.stringify({stage:'product_profile',step:step+1,state:d.product.state,committedUsd:report.committedUsd}));
  }
  if(d.product.state!=='target_review')throw Error('Product profile did not reach review: '+d.product.error);
  report.profile=d.analysis;report.revision=d.product.revision;report.status='profile_needs_review';save();
 }
 if(phase==='outreach'){
  report.status='running';delete report.error;save();
  if(!process.argv.includes('--profile-reviewed'))throw Error('Review the actual profile and its source/remarks handling before approval');
  const p=report.productId;let detail=await api('/api/products/'+p);
  report.sender=await api('/api/products/'+p+'/sender',{});if(!report.sender.accepted)throw Error('Existing Gmail sender is not authorized');save();
  if(detail.product.state==='target_review')await api('/api/products/'+p+'/approve',{revision:detail.product.revision,profileReviewed:true});
  await api('/api/products/'+p+'/pause',{enabled:true});
  await api('/api/discover?product='+p,{});
  for(let step=0;step<24;step++){
   await api('/api/tick?product='+p,{});
   const d=await api('/api/export?product='+p);
   const qualified=d.drafts.filter(x=>!x.quality_hold&&d.leads.some(l=>l.id===x.lead_id&&l.contact_status==='publicly_sourced'&&l.email));
   const committed=d.expenses.reduce((n,x)=>n+(x.state==='settled'?x.actual:x.reserved),0);
   report.outreach={step:step+1,leads:d.leads.length,drafts:d.drafts.length,qualified:qualified.length,committedUsd:committed,jobs:d.tasks.map(j=>({kind:j.kind,state:j.state,error:j.error})),attempts:d.attempts};report.committedUsd=committed;save();
   console.log(JSON.stringify({stage:'outreach',step:step+1,leads:d.leads.length,drafts:d.drafts.length,qualified:qualified.length,committedUsd:committed}));
   if(d.messages.some(m=>m.direction==='outbound'))throw Error('No-send boundary violated');
   if(committed>2)throw Error('Validation cap exceeded');
   if(qualified.length){report.output={leads:d.leads,drafts:qualified,searches:d.searches};report.status='passed';break;}
   if(d.tasks.some(j=>['uncertain','failed','paused_provider'].includes(j.state)))throw Error('A provider or research stage needs attention');
  }
  if(report.status!=='passed')throw Error('No sourced qualified draft after bounded validation steps');
  report.completedAt=new Date().toISOString();save();
 }
 if(phase==='cleanup'||report.status==='passed'){
  await api('/api/products/'+report.productId+'/archive',{confirm:true});report.testWorkspaceArchived=true;save();console.log('Test workspace archived; no prospect emails approved or sent.');
 }
}catch(error){report.status='needs_attention';report.error=error.message;save();if(report.productId){try{await api('/api/products/'+report.productId+'/pause',{enabled:false});}catch{}}throw error;}
finally{await api('/api/logout',{});}
