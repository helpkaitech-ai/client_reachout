import {test} from 'node:test';
import assert from 'node:assert/strict';
import {database,readyLead,testSettings} from './helpers';
import {mockOpenAI} from './openai-fixture';
import {all,one,run,settings} from '../src/db';
import {defaults} from '../src/types';
import {validateSettings} from '../src/policy';
import {startDiscovery} from '../src/discovery';
import {processAvailableJobs,scheduleResearch,tick} from '../src/engine';
import {saveProduct,scopeProduct} from '../src/products';
import worker from '../src/index';

test('automatic discovery waits six days, while manual searches remain available after the explicit hold expires',async()=>{
 const {env,close}=database();env.OPENAI_API_KEY='test';
 try{
  assert.equal(defaults.discoveryIntervalDays,6);
  await startDiscovery(env,testSettings);await run(env,"UPDATE discovery_batches SET state='complete',created_at=?",new Date(Date.now()-5*86400000).toISOString());
  assert.equal((await startDiscovery(env,testSettings)).state,'cooldown');
  await run(env,"UPDATE discovery_batches SET created_at=?",new Date(Date.now()-6*86400000-1000).toISOString());
  assert.equal((await startDiscovery(env,testSettings)).state,'queued');
  await run(env,"UPDATE discovery_batches SET state='complete'");
  assert.equal((await startDiscovery(env,{...testSettings,discoveryPausedUntil:new Date(Date.now()-1000).toISOString()},testSettings.campaigns[0],'manual')).state,'queued');
 }finally{close();}
});

test('a search hold blocks automatic and manual enqueueing, including the hosted discover API',async()=>{
 const {env,close}=database();env.OPENAI_API_KEY='test';const pausedUntil=new Date(Date.now()+3*86400000).toISOString();
 try{
  const s={...testSettings,discoveryPausedUntil:pausedUntil};await run(env,'INSERT INTO settings(id,data) VALUES(1,?)',JSON.stringify(s));
  assert.equal((await startDiscovery(env,s)).state,'paused');assert.equal((await startDiscovery(env,s,s.campaigns[0],'manual')).state,'paused');
  const origin=env.APP_URL!,headers={Origin:origin,'X-Requested-With':'Prepyr','Content-Type':'application/json'},ctx={waitUntil:()=>{}} as unknown as ExecutionContext;
  const login=await worker.fetch(new Request(origin+'/api/login',{method:'POST',headers,body:JSON.stringify({password:env.ADMIN_PASSWORD})}),env,ctx);
  const response=await worker.fetch(new Request(origin+'/api/discover',{method:'POST',headers:{...headers,Cookie:login.headers.get('set-cookie')!.split(';')[0]},body:'{}'}),env,ctx);
  assert.equal(response.status,200);assert.equal((await response.json() as any).resumeAt,pausedUntil);
  assert.equal((await all(env,'SELECT * FROM discovery_batches')).length,0);assert.equal((await all(env,'SELECT * FROM jobs')).length,0);
 }finally{close();}
});

test('queued discovery defers until the hold ends and existing research continues without repeating completed paid stages',async()=>{
 const {env,close}=database();env.OPENAI_API_KEY='test';env.ENABLE_AUTOMATION='true';const original=globalThis.fetch,{fetcher,calls}=mockOpenAI();globalThis.fetch=fetcher;
 try{
  await startDiscovery(env,testSettings);const pausedUntil=new Date(Date.now()+3*86400000).toISOString();
  await run(env,'INSERT INTO settings(id,data) VALUES(1,?)',JSON.stringify({...testSettings,discoveryPausedUntil:pausedUntil}));await readyLead(env);await scheduleResearch(env);
  await processAvailableJobs(env);const job=await one<any>(env,"SELECT * FROM jobs WHERE kind='discover_search'");assert.equal(job.state,'paused');assert.equal(job.next_run_at,pausedUntil);assert.equal(calls.length,0);
  for(let i=0;i<6;i++)await tick(env);
  assert.equal((await all(env,'SELECT * FROM drafts')).length,1);assert.equal(calls.length,6);assert.equal((await all(env,'SELECT * FROM discovery_batches')).length,1);
  assert.equal((await one<any>(env,"SELECT * FROM jobs WHERE kind='discover_search'")).state,'paused');assert.equal((await all(env,'SELECT * FROM messages')).length,0);
  await run(env,"UPDATE settings SET data=json_set(data,'$.discoveryPausedUntil','')");await run(env,"UPDATE jobs SET next_run_at=? WHERE kind='discover_search'",new Date(Date.now()-1000).toISOString());
  await tick(env);assert.equal(calls.length,7);assert.equal((await one<any>(env,"SELECT * FROM jobs WHERE kind='discover_search'")).state,'pending');
 }finally{globalThis.fetch=original;close();}
});

test('new product workspaces start paused independently of the Existing outreach hold and retain dedicated limits',async()=>{
 const {env,close}=database();try{
  const pausedUntil=new Date(Date.now()+3*86400000).toISOString();await run(env,'INSERT INTO settings(id,data) VALUES(1,?)',JSON.stringify({...testSettings,discoveryPausedUntil:pausedUntil}));
  const p=await saveProduct(env,{name:'Product',website:'https://pumps.example.com',description:'Quote management product',sender_email:'data@prepyr.com'}),scoped=await scopeProduct(env,p),s=await settings(scoped);
  assert.equal(s.discoveryPausedUntil,'');assert.equal(s.prospectingPaused,true);assert.equal(s.discoveryIntervalDays,6);assert.equal(s.dailyResearchLimit,20);assert.equal(s.openaiBudget,50);
  assert.throws(()=>validateSettings({...testSettings,discoveryPausedUntil:'tomorrow'}),/Invalid discovery pause date/);
  assert.throws(()=>validateSettings({...testSettings,discoveryPausedUntil:42} as any),/Invalid discovery pause date/);
 }finally{close();}
});
