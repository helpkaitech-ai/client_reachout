import {test} from 'node:test';
import assert from 'node:assert/strict';
import {database,readyLead,readyDraft,testSettings} from './helpers';
import {all,enqueue,now,one,reserve,run,settle} from '../src/db';
import {recoverUnstartedResearch,researchBacklog,scheduleResearch,tick} from '../src/engine';
import {jsonRequest,ProviderError} from '../src/providers';
import worker from '../src/index';

test('bulk scheduling handles 100 leads with bounded database calls and no duplicate jobs',async()=>{
 const {env,close}=database();try{
  for(let i=0;i<100;i++)await readyLead(env,{company:'Batch '+i,email:`hello@batch${i}.example.com`});
  const prepare=env.DB.prepare.bind(env.DB);let queries=0;
  env.DB.prepare=((sql:string)=>{queries++;return prepare(sql);}) as typeof env.DB.prepare;
  await scheduleResearch(env);await scheduleResearch(env);
  assert.equal(queries,2);assert.equal((await all(env,'SELECT id FROM jobs')).length,100);
 }finally{close();}
});

test('only interrupted research with zero provider history is safely recovered',async()=>{
 const {env,close}=database();try{
  const ids=[];for(let i=0;i<5;i++){
   const lead=await readyLead(env,{company:'Interrupted '+i,email:`hello@interrupted${i}.example.com`});ids.push(lead.id);
   await enqueue(env,'research',lead.id,{},'initial-v2:'+lead.id);
  }
  await run(env,"UPDATE jobs SET state='uncertain',error='Worker stopped during paid work. Inspect provider before retry.'");
  await reserve(env,'openai',0.4,50,ids[1]+':research');
  const paid=await reserve(env,'openai',0.4,50,ids[2]+':research');await settle(env,paid,0.1);
  await readyDraft(env,(await one<any>(env,'SELECT * FROM leads WHERE id=?',ids[3]))!);
  await run(env,"UPDATE jobs SET error='OpenAI request outcome is uncertain' WHERE lead_id=?",ids[4]);
  await recoverUnstartedResearch(env);await recoverUnstartedResearch(env);
  const jobs=await all<any>(env,'SELECT * FROM jobs');
  assert.deepEqual(jobs.filter(j=>j.state==='pending').map(j=>j.lead_id),[ids[0]]);
  assert.equal(jobs.filter(j=>j.state==='uncertain').length,4);
  assert.equal((await one<any>(env,"SELECT COUNT(*) n FROM events WHERE type='unstarted_research_recovered'")).n,1);
 }finally{close();}
});

test('provider quota codes are visible without exposing provider body contents',async()=>{
 const original=globalThis.fetch;try{
  globalThis.fetch=(async()=>Response.json({error:{code:'insufficient_quota',message:'secret-key-value'}},{status:429})) as typeof fetch;
  await assert.rejects(jsonRequest('OpenAI','https://api.example.com'),(error:any)=>error instanceof ProviderError&&error.message==='OpenAI returned HTTP 429 (insufficient_quota)'&&!error.message.includes('secret-key'));
 }finally{globalThis.fetch=original;}
});

test('manual research cannot bypass an unresolved paid job',async()=>{
 const {env,close}=database();try{
  const lead=await readyLead(env);await enqueue(env,'research',lead.id,{},'interrupted');
  await run(env,"UPDATE jobs SET state='uncertain' WHERE id='interrupted'");
  const origin=env.APP_URL!,headers={Origin:origin,'X-Requested-With':'Prepyr','Content-Type':'application/json'};
  const ctx={waitUntil:()=>{}} as unknown as ExecutionContext;
  const login=await worker.fetch(new Request(origin+'/api/login',{method:'POST',headers,body:JSON.stringify({password:env.ADMIN_PASSWORD})}),env,ctx);
  const response=await worker.fetch(new Request(origin+`/api/leads/${lead.id}/research`,{method:'POST',headers:{...headers,Cookie:login.headers.get('Set-Cookie')!.split(';')[0]},body:'{}'}),env,ctx);
  assert.equal(response.status,400);assert.equal((await all(env,'SELECT * FROM jobs')).length,1);
 }finally{close();}
});
