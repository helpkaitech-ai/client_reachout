import {saveProduct,scopeProduct,product} from '../src/products';
import worker from '../src/index';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {database,readyLead,readyDraft,testSettings,mockGoogle} from './helpers';
import {all,one,run,now,enqueue,settings} from '../src/db';
import {startDiscovery} from '../src/discovery';
import {currentCycle,discoveryProgress} from '../src/discovery-cycles';
import {recordAdmission} from '../src/qualified-prospects';
import {stopSearch,deleteProspect} from '../src/search-controls';
import {prospectPage} from '../src/prospects';
import {assertJobActive,WorkCancelled} from '../src/job-control';
import {openai} from '../src/providers';
import {ingestMessage} from '../src/mail';
import {approvalProblems} from '../src/policy';

async function fixture(){
 const x=database();x.env.OPENAI_API_KEY='fixture';await run(x.env,'INSERT INTO settings VALUES(1,?)',JSON.stringify(testSettings));
 const old=await readyLead(x.env),oldDraft=await readyDraft(x.env,old);await run(x.env,"UPDATE drafts SET status='pending' WHERE id=?",oldDraft.id);
 const started=await startDiscovery(x.env,testSettings,undefined,undefined,true,false,3),cycle=await currentCycle(x.env);
 const lead=await readyLead(x.env,{company:'Fresh supplier',email:'fresh@example.org',website:'https://fresh.example.org'}),draft=await readyDraft(x.env,lead);await run(x.env,"UPDATE drafts SET status='pending' WHERE id=?",draft.id);
 await run(x.env,"INSERT INTO discovery_candidates(id,batch_id,entity_key,data,outcome,lead_id,created_at) VALUES('new-candidate',?,'fresh','{}','imported',?,?)",started.runId,lead.id,now());await recordAdmission(x.env,lead.id,draft.id);
 await enqueue(x.env,'research',lead.id,{manual:true},'unfinished');await enqueue(x.env,'reply',old.id,{},'reply-work');
 return {...x,old,oldDraft,lead,draft,cycle};
}
test('partial results appear during research; stopping keeps qualified drafts and unrelated email work, then permits a new search',async()=>{
 const x=await fixture();try{
  let progress=await discoveryProgress(x.env,testSettings);assert.equal(progress.qualified,1);assert.equal(progress.percent,33);assert.equal(progress.canStop,true);
  assert.equal((await prospectPage(x.env,new URL('https://test/api/prospects'))).rows.length,2);
  const stopped=await stopSearch(x.env,x.cycle.id);assert.equal(stopped.campaign.state,'stopped');assert.equal(stopped.campaign.qualified,1);assert.equal(stopped.campaign.canStop,false);
  assert.equal((await one<any>(x.env,"SELECT state FROM jobs WHERE id='unfinished'")).state,'cancelled');assert.equal((await one<any>(x.env,"SELECT state FROM jobs WHERE id='reply-work'")).state,'pending');
  assert.equal((await prospectPage(x.env,new URL('https://test/api/prospects'))).rows.length,2);assert.equal((await one<any>(x.env,'SELECT status FROM drafts WHERE id=?',x.draft.id)).status,'pending');
  await assert.rejects(assertJobActive(x.env,{jobId:'unfinished'}),WorkCancelled);
  await startDiscovery(x.env,testSettings,undefined,undefined,true,false,5);progress=await discoveryProgress(x.env,testSettings);assert.equal(progress.target,5);assert.equal(progress.percent,0);assert.notEqual(progress.id,x.cycle.id);
  await assert.rejects(stopSearch(x.env,x.cycle.id),/changed/);
 }finally{x.close();}
});
test('delete removes pending and sent rows, cancels queued work, and stale callbacks cannot restore the prospect',async()=>{
 const x=await fixture();try{
  await run(x.env,"UPDATE drafts SET status='sent' WHERE id=?",x.oldDraft.id);await deleteProspect(x.env,x.old.id);
  assert.equal((await prospectPage(x.env,new URL('https://test/api/prospects?group=sent'))).total,0);
  await run(x.env,"UPDATE leads SET status='review' WHERE id=?",x.old.id);assert.equal((await one<any>(x.env,'SELECT status FROM leads WHERE id=?',x.old.id)).status,'deleted');
  await ingestMessage(x.env,x.old,{id:'late-reply',payload:{}});assert.equal((await all(x.env,"SELECT * FROM messages WHERE id='late-reply'")).length,0);
  await deleteProspect(x.env,x.lead.id);const current=await one<any>(x.env,'SELECT * FROM leads WHERE id=?',x.lead.id);assert.ok(approvalProblems(x.draft,current,testSettings).includes('This business is blocked from outreach'));
  assert.equal((await prospectPage(x.env,new URL('https://test/api/prospects'))).total,0);assert.equal((await one<any>(x.env,'SELECT status FROM drafts WHERE id=?',x.draft.id)).status,'cancelled');
 }finally{x.close();}
});
test('an in-flight paid response is accounted for but cannot advance a stopped job',async()=>{
 const x=await fixture(),original=globalThis.fetch;let submitted!:()=>void,finish!:()=>void;const waiting=new Promise<void>(r=>submitted=r),gate=new Promise<void>(r=>finish=r);
 globalThis.fetch=async()=>{submitted();await gate;return Response.json({status:'completed',id:'fixture-response',usage:{input_tokens:10,output_tokens:10},output:[]});};
 try{
  const response=openai(x.env,testSettings,'fixture','fixture','cancel-test',{workflow:{jobId:'unfinished',paidCalls:0},stage:'fixture'});await waiting;await stopSearch(x.env,x.cycle.id);finish();await assert.rejects(response,WorkCancelled);
  assert.equal((await one<any>(x.env,"SELECT state FROM ai_attempts WHERE job_id='unfinished'")).state,'complete');assert.equal((await one<any>(x.env,"SELECT state FROM expenses WHERE reference='cancel-test'")).state,'settled');
 }finally{finish();globalThis.fetch=original;x.close();}
});


async function req(env:any,path:string,body?:any,cookie=''){return worker.fetch(new Request(env.APP_URL+path,{method:body===undefined?'GET':'POST',headers:{Origin:env.APP_URL,'X-Requested-With':'Prepyr',Cookie:cookie},...(body===undefined?{}:{body:JSON.stringify(body)})}),env,{waitUntil:()=>{}} as any);}
test('authenticated send works during research; stop and delete endpoints require authentication',async()=>{
 const x=await fixture(),original=globalThis.fetch;let sent=0;Object.assign(x.env,{ENABLE_SENDING:'true',GOOGLE_CLIENT_ID:'fixture',GOOGLE_CLIENT_SECRET:'fixture',GOOGLE_REFRESH_TOKEN:'fixture'});globalThis.fetch=mockGoogle(()=>{sent++;return Response.json({id:'fixture-message',threadId:'fixture-thread'});});
 try{
  assert.equal((await req(x.env,'/api/discovery/stop',{})).status,401);assert.equal((await req(x.env,`/api/prospects/${x.lead.id}/delete`,{})).status,401);
  const login=await req(x.env,'/api/login',{password:x.env.ADMIN_PASSWORD}),cookie=login.headers.get('set-cookie')!.split(';')[0];
  const response=await req(x.env,`/api/drafts/${x.oldDraft.id}/approve`,{version:1,evidenceReviewed:true,contactReviewed:true},cookie);assert.equal(response.status,200);assert.equal((await response.json() as any).status,'sent');assert.equal(sent,1);assert.equal((await discoveryProgress(x.env,testSettings)).canStop,true);
  assert.equal((await req(x.env,'/api/discovery/stop',{cycleId:x.cycle.id},cookie)).status,200);assert.equal((await req(x.env,`/api/prospects/${x.lead.id}/delete`,{},cookie)).status,200);
 }finally{globalThis.fetch=original;x.close();}
});


test('stopping profile preparation cancels the search intent; late continuation cannot restart it',async()=>{
 const {env,close}=database();env.OPENAI_API_KEY='fixture';try{
  const p=await saveProduct(env,{name:'Product',website:'https://example.com',description:'Business reporting',sender_email:'data@prepyr.com'}),scope=await scopeProduct(env,p);
  await run(env,"UPDATE products SET state='analyzing' WHERE id=?",p.id);await run(scope,"INSERT INTO integration_state VALUES('manual_search_request',?)",JSON.stringify({id:'requested-search',revision:p.revision,target:7}));await enqueue(scope,'product_analysis',null,{revision:p.revision},'profile-job');
  assert.equal((await discoveryProgress(scope,await settings(scope))).canStop,true);await stopSearch(scope);assert.equal((await product(env,p.id)).state,'draft');assert.equal(await one(scope,"SELECT value FROM integration_state WHERE key='manual_search_request'"),null);assert.equal((await one<any>(scope,"SELECT state FROM jobs WHERE id='profile-job'")).state,'cancelled');
  const result=await startDiscovery({...scope,PRODUCT_APPROVED:true},await settings(scope),undefined,undefined,true,false,7,'requested-search');assert.equal(result.state,'stopped');assert.equal((await all(scope,'SELECT * FROM discovery_cycles')).length,0);
 }finally{close();}
});
test('stop and delete remain isolated to the selected product workspace',async()=>{
 const {env,close}=database();env.OPENAI_API_KEY='fixture';try{
  const a=await saveProduct(env,{name:'A',website:'https://example.com',description:'A',sender_email:'data@prepyr.com'}),b=await saveProduct(env,{name:'B',website:'https://example.org',description:'B',sender_email:'data@prepyr.com'});
  const sa=await scopeProduct(env,a),sb=await scopeProduct(env,b),lead=await readyLead(sa),draft=await readyDraft(sa,lead);await enqueue(sa,'research',lead.id,{},'work-a');await enqueue(sb,'research',null,{},'work-b');
  await assert.rejects(deleteProspect(sb,lead.id),/not found/);assert.equal((await one<any>(sa,'SELECT status FROM drafts WHERE id=?',draft.id)).status,'approved');
  await deleteProspect(sa,lead.id);assert.equal((await one<any>(sb,"SELECT state FROM jobs WHERE id='work-b'")).state,'pending');assert.equal((await one<any>(sa,"SELECT state FROM jobs WHERE id='work-a'")).state,'cancelled');
 }finally{close();}
});
