import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index';
import {database} from './helpers';
const origin='https://outreach.example.com';
const quota="D1_ERROR: Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.";
function request(env:any,path:string,payload?:unknown,cookie?:string,headers:Record<string,string>={}) {
 return worker.fetch(new Request(origin+path,{method:payload===undefined?'GET':'POST',headers:{Origin:origin,'X-Requested-With':'Prepyr',...(cookie?{Cookie:cookie}:{}),...headers},...(payload===undefined?{}:{body:JSON.stringify(payload)})}),env,{waitUntil:()=>{}} as unknown as ExecutionContext);
}
async function signIn(env:any){const r=await request(env,'/api/login',{password:env.ADMIN_PASSWORD});assert.equal(r.status,200);const header=r.headers.get('Set-Cookie')!;assert.match(header,/HttpOnly; SameSite=Strict/);assert.match(header,/; Secure/);return header.split(';')[0];}
test('exact production D1 outage does not affect login, session validation or revoking logout',async()=>{
 const {env,close}=database();let calls=0;env.DB={prepare:()=>{calls++;throw new Error(quota);}} as unknown as D1Database;
 try{
  assert.equal((await request(env,'/api/dashboard')).status,401);
  const wrong=await request(env,'/api/login',{password:'incorrect'});assert.equal(wrong.status,401);assert.equal((await wrong.json() as any).error,'Incorrect password');
  const cookie=await signIn(env);assert.equal((await request(env,'/api/session',undefined,cookie)).status,200);assert.equal(calls,0);
  for(const path of ['/api/dashboard','/api/prospects','/api/export','/api/settings']){
   const r=await request(env,path,path==='/api/settings'?{}:undefined,cookie);assert.equal(r.status,503);assert.equal((await r.json() as any).code,'DATABASE_DAILY_LIMIT');assert.ok(Number(r.headers.get('Retry-After'))>0);
  }
  const before=calls;assert.equal((await request(env,'/api/session',undefined,cookie)).status,200);
  const logout=await request(env,'/api/logout',{},cookie);assert.equal(logout.status,200);assert.match(logout.headers.get('Set-Cookie')!,/Max-Age=0/);
  assert.equal((await request(env,'/api/session',undefined,cookie)).status,401);assert.equal(calls,before);
 }finally{close();}
});
test('D1 outage never disables password throttling; attempt window resets after 15 minutes',async()=>{
 const {env,close}=database(),original=Date.now;let time=original();Date.now=()=>time;env.DB={prepare:()=>{throw new Error(quota);}} as unknown as D1Database;
 try{for(let i=0;i<8;i++)assert.equal((await request(env,'/api/login',{password:'wrong'})).status,401);const denied=await request(env,'/api/login',{password:env.ADMIN_PASSWORD});assert.equal(denied.status,401);assert.match((await denied.json() as any).error,/Too many/);time+=15*60000;await signIn(env);}finally{Date.now=original;close();}
});
test('sessions expire at twelve hours and legacy or forged cookies cannot authenticate',async()=>{
 const {env,close}=database(),original=Date.now;let time=original();Date.now=()=>time;
 try{const cookie=await signIn(env);assert.equal((await request(env,'/api/session',undefined,'prepyr_session=legacy-d1-token')).status,401);assert.equal((await request(env,'/api/session',undefined,'prepyr_session=v2_'+'a'.repeat(43))).status,401);time+=12*3600000;assert.equal((await request(env,'/api/session',undefined,cookie)).status,401);}finally{Date.now=original;close();}
});
test('authentication storage failure fails closed with 503 and never falls back to D1',async()=>{
 const {env,close}=database();let calls=0;env.DB={prepare:()=>{calls++;throw new Error(quota);}} as unknown as D1Database;
 env.AUTH_STORE={idFromName:()=>{throw new Error('Private storage failure');}} as unknown as DurableObjectNamespace;
 try{for(const [path,payload,cookie] of [['/api/login',{password:env.ADMIN_PASSWORD},undefined],['/api/session',undefined,'prepyr_session=v2_'+'a'.repeat(43)]] as const){const r=await request(env,path,payload,cookie);assert.equal(r.status,503);assert.doesNotMatch(await r.text(),/Private storage failure|D1_ERROR/);}assert.equal(calls,0);}finally{close();}
});
test('cross-origin login and logout remain blocked during D1 outages',async()=>{
 const {env,close}=database();try{const cookie=await signIn(env);for(const path of ['/api/login','/api/logout'])assert.equal((await request(env,path,{password:env.ADMIN_PASSWORD},cookie,{Origin:'https://attacker.example'})).status,403);assert.equal((await request(env,'/api/session',undefined,cookie)).status,200);}finally{close();}
});
