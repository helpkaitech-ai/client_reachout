import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {JSDOM} from 'jsdom';
import {readEnv,root} from './env.mjs';
const local=process.argv.includes('--local');
const config=local?{APP_URL:'http://127.0.0.1:8791',ADMIN_PASSWORD:'local-auth-outage-fixture-only'}:readEnv();
const origin=new URL(config.APP_URL).origin;
const checks=[];let cookie='',databaseStatus;
async function check(name,fn){await fn();checks.push({check:name,passed:true});console.log('PASS '+name);}
async function request(url,init={}){
 const headers=new Headers(init.headers);headers.set('Origin',origin);headers.set('X-Requested-With','Prepyr');if(cookie)headers.set('Cookie',cookie);
 const r=await fetch(new URL(url,origin),{...init,headers});const value=r.headers.get('set-cookie');if(value)cookie=value.split(';')[0];return r;
}
await check('anonymous session and workspace requests are denied',async()=>{for(const route of ['/api/session','/api/dashboard'])assert.equal((await request(route)).status,401);});
await check('incorrect password is rejected without a database dependency',async()=>{const r=await request('/api/login',{method:'POST',body:JSON.stringify({password:'deliberately-invalid-auth-smoke-password'})});assert.equal(r.status,401);assert.equal((await r.json()).error,'Incorrect password');});
await check('password login establishes a protected session',async()=>{const r=await request('/api/login',{method:'POST',body:JSON.stringify({password:config.ADMIN_PASSWORD})});assert.equal(r.status,200);assert.match(r.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);if(!local)assert.match(r.headers.get('set-cookie'),/; Secure/);});
await check('session validates independently of workspace queries',async()=>{const r=await request('/api/session');assert.equal(r.status,200);assert.equal((await r.json()).authenticated,true);});
await check('workspace responds with data or the explicit quota availability message',async()=>{const r=await request('/api/dashboard');databaseStatus=r.status;assert.ok([200,503].includes(r.status));const value=await r.json();if(r.status===503){assert.equal(value.code,'DATABASE_DAILY_LIMIT');assert.ok(r.headers.get('Retry-After'));assert.ok(value.resetAt);assert.doesNotMatch(value.error,/D1_ERROR/);}else assert.ok(value.settings);});
await check('cross-origin logout is denied and leaves the session intact',async()=>{const r=await fetch(origin+'/api/logout',{method:'POST',headers:{Cookie:cookie,Origin:'https://attacker.example','X-Requested-With':'Prepyr'},body:'{}'});assert.equal(r.status,403);assert.equal((await request('/api/session')).status,200);});
await check('logout revokes the cookie on the server',async()=>{const old=cookie;assert.equal((await request('/api/logout',{method:'POST',body:'{}'})).status,200);cookie=old;assert.equal((await request('/api/session')).status,401);cookie='';});
await check('actual UI login opens workspace and survives reload during a D1 outage',async()=>{
 const html=await(await request('/')).text(),code=await(await request('/app.js')).text();
 const dom=new JSDOM(html,{url:origin,runScripts:'outside-only'}),doc=dom.window.document;
 dom.window.fetch=request;
 const waitFor=async(fn)=>{const end=Date.now()+10000;while(!fn()){if(Date.now()>end)throw new Error('UI state timed out');await new Promise(r=>setTimeout(r,25));}};
 try{
  dom.window.eval(code);await new Promise(r=>setTimeout(r,150));
  doc.querySelector('#password').value=config.ADMIN_PASSWORD;
  doc.querySelector('#login-form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));
  await waitFor(()=>!doc.querySelector('#app').hidden&&doc.querySelector('#content').textContent.trim());
  assert.equal(doc.querySelector('#login').hidden,true);assert.equal(doc.querySelector('#login-error').textContent,'');
  if(databaseStatus===503){assert.match(doc.querySelector('#content').textContent,/temporarily unavailable/);assert.equal(doc.querySelector('table'),null);}
  dom.window.eval('load()');await new Promise(r=>setTimeout(r,200));assert.equal(doc.querySelector('#login').hidden,true);
  doc.querySelector('#logout').click();await waitFor(()=>!doc.querySelector('#login').hidden);assert.equal((await request('/api/session')).status,401);
 }finally{dom.window.close();}
});
fs.mkdirSync(path.join(root,'artifacts'),{recursive:true});
fs.writeFileSync(path.join(root,'artifacts',local?'auth-local-runtime.json':'auth-hosted-smoke.json'),JSON.stringify({url:origin,time:new Date().toISOString(),databaseStatus,checks},null,2));
console.log(`Verified ${checks.length} authentication checks; workspace HTTP ${databaseStatus}.`);
