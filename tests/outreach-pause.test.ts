import {test} from 'node:test';
import assert from 'node:assert/strict';
import {database,readyLead,readyDraft,testSettings} from './helpers';
import {all,one,run,settings,now} from '../src/db';
import {tickWorkspaces,processAvailableJobs,scheduleResearch} from '../src/engine';
import {openai} from '../src/providers';
import {sendApproved,notifyDigest} from '../src/mail';
import {saveProduct,scopeProduct} from '../src/products';
import {controlOutreach,outreachPaused} from '../src/outreach-control';
import {mockOpenAI} from './openai-fixture';
import worker from '../src/index';

const origin='https://outreach.example.com',ctx={waitUntil:()=>{}} as unknown as ExecutionContext;
async function req(env:any,path:string,payload?:any,cookie?:string,from=origin){return worker.fetch(new Request(origin+path,{method:payload===undefined?'GET':'POST',headers:{Origin:from,'X-Requested-With':'Prepyr',...(cookie?{Cookie:cookie}:{})},...(payload===undefined?{}:{body:JSON.stringify(payload)})}),env,ctx);}
async function login(env:any){const r=await req(env,'/api/login',{password:env.ADMIN_PASSWORD});return r.headers.get('set-cookie')!.split(';')[0];}

test('persistent outreach pause blocks all paid jobs, product analysis, email sending and external notifications with zero provider calls',async()=>{
 const {env,close}=database(),original=globalThis.fetch;let calls=0;globalThis.fetch=(async()=>{calls++;throw Error('No provider may be called');}) as typeof fetch;
 Object.assign(env,{OPENAI_API_KEY:'test',ENABLE_AUTOMATION:'true',ENABLE_SENDING:'true',ENABLE_NOTIFICATIONS:'true',NOTIFY_EMAIL:'owner@example.com'});
 try{
  await run(env,'INSERT INTO settings(id,data) VALUES(1,?)',JSON.stringify({...testSettings,outreachPaused:true,discoveryPaused:true,discoveryPausedUntil:'2020-01-01T00:00:00.000Z'}));
  const lead=await readyLead(env);await readyDraft(env,lead);await scheduleResearch(env);const p=await saveProduct(env,{name:'Paused product',website:'https://pumps.example.com',description:'Pump quote product',sender_email:'data@prepyr.com'});await run(env,"UPDATE products SET state='analyzing' WHERE id=?",p.id);
  await tickWorkspaces(env);await processAvailableJobs(env);await sendApproved(env,testSettings);await notifyDigest(env,testSettings,true);await assert.rejects(openai(env,testSettings,'x','x','paused',{search:true,workflow:{jobId:'paid',paidCalls:0}}),/Outreach is paused/);
  assert.equal(calls,0);assert.equal((await all(env,'SELECT * FROM ai_attempts')).length,0);assert.equal((await all(env,'SELECT * FROM expenses')).length,0);assert.equal((await all(env,'SELECT * FROM messages')).length,0);assert.ok(await outreachPaused(env));
 }finally{globalThis.fetch=original;close();}
});

test('paused manual endpoints cannot spend or approve emails; settings cannot silently clear the pause',async()=>{
 const {env,close}=database(),original=globalThis.fetch;let calls=0;globalThis.fetch=(async()=>{calls++;throw Error('No provider');}) as typeof fetch;env.OPENAI_API_KEY='test';
 try{
  await run(env,'INSERT INTO settings(id,data) VALUES(1,?)',JSON.stringify({...testSettings,outreachPaused:true,discoveryPaused:true}));const lead=await readyLead(env),draft=await readyDraft(env,lead);await run(env,"UPDATE drafts SET status='pending' WHERE id=?",draft.id);const cookie=await login(env);
  for(const path of ['/api/discover',`/api/leads/${lead.id}/research`,`/api/drafts/${draft.id}/approve`,`/api/drafts/${draft.id}/rewrite`])assert.equal((await req(env,path,{version:1,evidenceReviewed:true,contactReviewed:true},cookie)).status,400);
  assert.equal((await req(env,'/api/discovery/control',{paused:false},cookie)).status,400);
  assert.equal((await req(env,'/api/settings/preferences',{...testSettings,outreachPaused:false,discoveryPaused:false,discoveryIntervalDays:1},cookie)).status,200);const s=await settings(env);assert.equal(s.outreachPaused,true);assert.equal(s.discoveryPaused,true);assert.equal(s.discoveryIntervalDays,6);
  assert.equal((await req(env,'/api/notifications',undefined,cookie)).status,200);assert.equal(calls,0);assert.equal((await one<any>(env,'SELECT status FROM drafts WHERE id=?',draft.id)).status,'pending');
 }finally{globalThis.fetch=original;close();}
});

test('resume requires authenticated same-origin owner action and leaves workspace discovery paused without running a search',async()=>{
 const {env,close}=database(),original=globalThis.fetch;let calls=0;globalThis.fetch=(async()=>{calls++;throw Error('No provider');}) as typeof fetch;env.OPENAI_API_KEY='test';
 try{
  await run(env,'INSERT INTO settings(id,data) VALUES(1,?)',JSON.stringify({...testSettings,outreachPaused:true,discoveryPaused:true}));assert.equal((await req(env,'/api/outreach/control',{paused:false})).status,401);const cookie=await login(env);assert.equal((await req(env,'/api/outreach/control',{paused:false},cookie,'https://wrong.example')).status,403);
  assert.equal((await req(env,'/api/outreach/control',{paused:false},cookie)).status,200);assert.equal((await settings(env)).outreachPaused,false);assert.equal((await settings(env)).discoveryPaused,true);assert.equal((await(await req(env,'/api/discover',{},cookie)).json() as any).state,'paused');
  assert.equal((await req(env,'/api/discovery/control',{paused:false},cookie)).status,200);assert.equal((await settings(env)).discoveryPaused,false);assert.equal((await settings(env)).discoveryIntervalDays,6);assert.equal((await all(env,'SELECT * FROM discovery_batches')).length,0);assert.equal(calls,0);
 }finally{globalThis.fetch=original;close();}
});

test('product discovery resumes independently and stale product contexts cannot bypass a new global pause',async()=>{
 const {env,close}=database();env.OPENAI_API_KEY='test';try{
  await run(env,'INSERT INTO settings(id,data) VALUES(1,?)',JSON.stringify({...testSettings,discoveryPaused:true}));const a=await saveProduct(env,{name:'A',website:'https://pumps.example.com',description:'Product A',sender_email:'data@prepyr.com'}),b=await saveProduct(env,{name:'B',website:'https://pumps.example.com',description:'Product B',sender_email:'data@prepyr.com'});
  await run(env,"UPDATE products SET state='approved',approved_revision=revision");const scope=await scopeProduct(env,{...a,state:'approved',approved_revision:a.revision}),cookie=await login(env);assert.equal((await settings(scope)).discoveryPaused,true);
  assert.equal((await req(env,'/api/discovery/control?product='+a.id,{paused:false},cookie)).status,200);assert.equal((await settings(scope)).discoveryPaused,false);assert.equal((await settings(await scopeProduct(env,{...b,state:'approved',approved_revision:b.revision}))).discoveryPaused,true);
  await controlOutreach(env,{paused:true});await assert.rejects(openai(scope,testSettings,'x','x','stale',{search:true,workflow:{jobId:'stale',paidCalls:0}}),/Outreach is paused/);assert.equal((await all(scope,'SELECT * FROM expenses')).length,0);
 }finally{close();}
});

test('pausing during an active workflow saves completed work and resumes without repeating a paid stage',async()=>{
 const {env,close}=database(),original=globalThis.fetch,{fetcher,calls}=mockOpenAI();env.OPENAI_API_KEY='test';let paused=false;
 globalThis.fetch=(async(url:any,init:any)=>{const response=await fetcher(url,init);if(!paused){paused=true;await controlOutreach(env,{paused:true});}return response;}) as typeof fetch;
 try{
  await run(env,'INSERT INTO settings(id,data) VALUES(1,?)',JSON.stringify(testSettings));await readyLead(env);await scheduleResearch(env);await processAvailableJobs(env);await processAvailableJobs(env);assert.equal(calls.length,1);assert.equal((await one<any>(env,'SELECT state FROM jobs')).state,'pending');
  await controlOutreach(env,{paused:false});for(let i=0;i<8;i++)await processAvailableJobs(env);assert.equal(calls.length,6);assert.equal((await all(env,'SELECT * FROM drafts')).length,1);
 }finally{globalThis.fetch=original;close();}
});

test('the pause control initializes empty settings safely',async()=>{const {env,close}=database();try{await controlOutreach(env,{paused:true});assert.equal(await outreachPaused(env),true);}finally{close();}});
