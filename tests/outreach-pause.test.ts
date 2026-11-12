import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {database,readyLead,readyDraft,testSettings} from './helpers';
import {all,one,run,settings,enqueue} from '../src/db';
import {tickWorkspaces,processJob,processAvailableJobs,scheduleResearch} from '../src/engine';
import {mockOpenAI} from './openai-fixture';
import {saveProduct,product,scopeProduct,requestProductDiscovery} from '../src/products';
import worker from '../src/index';
const origin='https://outreach.example.com',ctx={waitUntil:()=>{}} as unknown as ExecutionContext;
async function req(env:any,path:string,payload?:any,cookie?:string,from=origin){return worker.fetch(new Request(origin+path,{method:payload===undefined?'GET':'POST',headers:{Origin:from,'X-Requested-With':'Prepyr',...(cookie?{Cookie:cookie}:{})},...(payload===undefined?{}:{body:JSON.stringify(payload)})}),env,ctx);}
async function login(env:any){const r=await req(env,'/api/login',{password:env.ADMIN_PASSWORD});return r.headers.get('set-cookie')!.split(';')[0];}

test('legacy pause flags cannot stop explicitly requested research or return in saved settings',async()=>{
 const x=database(),original=globalThis.fetch,ai=mockOpenAI();x.env.OPENAI_API_KEY='mock';globalThis.fetch=ai.fetcher;
 try{
  await run(x.env,'INSERT INTO settings VALUES(1,?)',JSON.stringify({...testSettings,outreachPaused:true,prospectingPaused:true,discoveryPaused:true,discoveryIntervalDays:6}));
  const lead=await readyLead(x.env);await enqueue(x.env,'research',lead.id,{manual:true});for(let i=0;i<10;i++)await processAvailableJobs(x.env);
  assert.equal((await all(x.env,'SELECT * FROM drafts')).length,1);assert.equal((await all(x.env,'SELECT * FROM messages')).length,0);
  const cookie=await login(x.env),response=await req(x.env,'/api/settings/preferences',{...testSettings,outreachPaused:true,discoveryIntervalDays:1},cookie);assert.equal(response.status,200);
  const saved=await settings(x.env);for(const key of ['outreachPaused','prospectingPaused','discoveryPaused','discoveryIntervalDays'])assert.equal(key in saved,false);
 }finally{globalThis.fetch=original;x.close();}
});

test('retired controls cannot reintroduce pause or profile approvals; authentication remains required',async()=>{
 const x=database();try{
  const p=await saveProduct(x.env,{name:'A',website:'https://pumps.example.com',description:'Product A',sender_email:'data@prepyr.com'});
  assert.equal((await req(x.env,'/api/outreach/control',{paused:true})).status,401);const cookie=await login(x.env);
  assert.equal((await req(x.env,'/api/outreach/control',{paused:true},cookie,'https://wrong.example')).status,403);
  for(const path of ['/api/outreach/control',`/api/products/${p.id}/pause`,`/api/products/${p.id}/prospecting`,`/api/products/${p.id}/approve`])assert.equal((await req(x.env,path,{paused:true,enabled:false,profileReviewed:true,revision:1},cookie)).status,410);
  assert.equal((await product(x.env,p.id)).state,'draft');assert.equal((await all(x.env,'SELECT * FROM discovery_batches')).length,0);
 }finally{x.close();}
});

test('legacy nonmanual discovery jobs never spend even if directly processed',async()=>{
 const x=database(),original=globalThis.fetch;let calls=0;x.env.OPENAI_API_KEY='mock';globalThis.fetch=(async()=>{calls++;throw Error('No search requested');}) as typeof fetch;
 try{await enqueue(x.env,'discover_search',null,{manual:false},'legacy');const job=await one<any>(x.env,"SELECT * FROM jobs WHERE id='legacy'");await processJob(x.env,job);await tickWorkspaces(x.env);assert.equal(calls,0);assert.equal((await one<any>(x.env,"SELECT state FROM jobs WHERE id='legacy'")).state,'cancelled');}finally{globalThis.fetch=original;x.close();}
});

test('previously disabled product searches prepare and apply its profile without approval',async()=>{
 const x=database(),original=globalThis.fetch,ai=mockOpenAI();x.env.OPENAI_API_KEY='mock';globalThis.fetch=ai.fetcher;
 try{const p=await saveProduct(x.env,{name:'A',website:'https://pumps.example.com',description:'Quotation workflow product',sender_email:'data@prepyr.com'});await run(x.env,'UPDATE products SET enabled=0 WHERE id=?',p.id);const scoped=await scopeProduct(x.env,await product(x.env,p.id));await requestProductDiscovery(scoped);for(let i=0;i<5;i++)await tickWorkspaces(x.env);assert.equal((await product(x.env,p.id)).state,'approved');assert.equal((await all(scoped,'SELECT * FROM discovery_batches')).length,1);}finally{globalThis.fetch=original;x.close();}
});

test('removal migration preserves drafts and history and does not dispatch old approvals from paused workspaces',async()=>{
 const x=database();try{
  const draft=await readyDraft(x.env,await readyLead(x.env));await run(x.env,'INSERT INTO settings VALUES(1,?)',JSON.stringify({...testSettings,outreachPaused:true,prospectingPaused:true,discoveryIntervalDays:6}));
  x.sqlite.exec(readFileSync('migrations/0014_remove_pause_controls.sql','utf8'));
  const updated=await one<any>(x.env,'SELECT * FROM drafts WHERE id=?',draft.id);assert.equal(updated.body,draft.body);assert.equal(updated.status,'pending');assert.equal(updated.approved_hash,null);
  const stored=JSON.parse((await one<any>(x.env,'SELECT data FROM settings')).data);assert.equal('outreachPaused' in stored,false);assert.equal('discoveryIntervalDays' in stored,false);
  assert.equal((await all(x.env,'SELECT * FROM discovery_batches')).length,0);
 }finally{x.close();}
});
