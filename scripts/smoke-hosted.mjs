import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const origin=process.env.APP_URL||'https://prepyr-outreach.prepyr-data.workers.dev';
const password=process.argv.includes('--authenticated')?process.env.ADMIN_PASSWORD:undefined;
if(!origin)throw new Error('Set APP_URL to the deployed Relay origin');
const checks=[],retired=['outreachPaused','prospectingPaused','discoveryPaused','discoveryPausedUntil','discoveryIntervalDays','researchAutomation'];
let cookie='';
async function request(route,body){return fetch(origin+route,{method:body===undefined?'GET':'POST',headers:{'User-Agent':'Mozilla/5.0 RelayReleaseCheck',...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{Origin:origin,'X-Requested-With':'Prepyr','Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});}
async function check(label,fn){await fn();checks.push({check:label,passed:true});console.log('PASS '+label);}
await check('published interface has Search prospects and no pause controls',async()=>{
 const response=await request('/');assert.equal(response.status,200);assert.ok(response.headers.get('content-security-policy'));
 const html=await response.text();assert.doesNotMatch(html,/outreach-toggle|outreach-state|Pause Relay|Resume Relay/);
 const js=await request('/app.js');assert.equal(js.status,200);const code=await js.text();assert.match(code,/Search prospects/);assert.doesNotMatch(code,/data-product-approve|Pause Relay|Resume Relay/);
});
await check('health and anonymous access protection',async()=>{
 const health=await request('/health');assert.equal(health.status,200);assert.equal((await health.json()).ok,true);
 for(const route of ['/api/dashboard','/api/notifications','/api/products'])assert.equal((await request(route)).status,401);
});
if(!password)console.log('SKIP authenticated checks: use --authenticated with ADMIN_PASSWORD explicitly supplied');
else{
try{
 await check('authenticated session',async()=>{const response=await request('/api/login',{password});assert.equal(response.status,200,'Hosted login failed');cookie=response.headers.get('set-cookie').split(';')[0];assert.match(response.headers.get('set-cookie'),/HttpOnly/);});
 await check('live workspaces expose manual discovery without legacy pause or interval settings',async()=>{
  const response=await request('/api/products');assert.equal(response.status,200);const {products}=await response.json();
  for(const id of ['',...products.map(p=>p.id)]){
   const query=id?'&product='+encodeURIComponent(id):'',r=await request('/api/dashboard?summary=1'+query);assert.equal(r.status,200);const data=await r.json();assert.equal(data.availability?.readOnly,undefined);
   for(const key of retired)assert.equal(key in data.settings,false,`Retired setting: ${key}`);
   assert.equal(data.connections.automationEnabled,false);assert.ok(data.settings.dailyLeadLimit>0);assert.ok(data.settings.openaiBudget<=50);
   const list=await request('/api/prospects?group=pending'+query);assert.equal(list.status,200);const page=await list.json();assert.ok(Array.isArray(page.rows));assert.ok(page.total>=page.rows.length);
  }
 });
 await check('retired program, product pause and profile approval endpoints cannot mutate state',async()=>{
  assert.equal((await request('/api/outreach/control',{paused:true})).status,410);
  const {products}=await(await request('/api/products')).json();
  if(products.length)for(const action of ['pause','prospecting','approve'])assert.equal((await request('/api/products/'+products[0].id+'/'+action,{})).status,410);
 });
}finally{
 if(cookie){const logout=await request('/api/logout',{});assert.equal(logout.status,200);assert.equal((await request('/api/dashboard')).status,401);}
}
}
fs.mkdirSync(path.join(root,'artifacts'),{recursive:true});fs.writeFileSync(path.join(root,'artifacts/hosted-smoke.json'),JSON.stringify({url:origin,time:new Date().toISOString(),checks},null,2));
