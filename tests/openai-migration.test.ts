import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {database,readyLead,readyDraft,testSettings,mockGoogle} from './helpers';
import {all,one,run,enqueue,now,month,BudgetPaused} from '../src/db';
import {startDiscovery} from '../src/discovery';
import {processAvailableJobs,processJob,researchBacklog,scheduleResearch} from '../src/engine';
import {StageYield} from '../src/ai';
import {openai,UncertainProviderError} from '../src/providers';
import {mockOpenAI} from './openai-fixture';
import {domainOf} from '../src/evidence';
import {entityKey} from '../src/leads';
import {researchContact} from '../src/intelligence';
import {draftLead} from '../src/research';
import {tick} from '../src/engine';
import {claimResearchBusiness} from '../src/db';
import {syncInbox} from '../src/mail';

test('OpenAI discovery checkpoints search and extraction, deduplicates clicks and imports supported SMBs',async()=>{
 const {env,close}=database();env.OPENAI_API_KEY='test';const original=globalThis.fetch,{fetcher,calls}=mockOpenAI();globalThis.fetch=fetcher;
 try{const first=await startDiscovery(env,testSettings,{...testSettings.campaigns[1],location:'London, UK'});const second=await startDiscovery(env,testSettings);assert.equal(first.runId,second.runId);assert.equal(calls.length,0);
 await processAvailableJobs(env);assert.equal(calls.length,1);assert.equal((await all(env,'SELECT * FROM leads')).length,0);
 await processAvailableJobs(env);assert.equal(calls.length,2);assert.equal((await all(env,'SELECT * FROM leads')).length,1);
 assert.equal((await one<any>(env,'SELECT * FROM discovery_batches')).state,'complete');
 assert.equal((await all(env,"SELECT * FROM ai_attempts WHERE state='complete'")).length,2);
 await processAvailableJobs(env);assert.equal(calls.length,2);
 }finally{globalThis.fetch=original;close();}
});
test('large chains remain held candidates and never become automatically researched prospects',async()=>{
 const {env,close}=database();env.OPENAI_API_KEY='test';const original=globalThis.fetch;globalThis.fetch=mockOpenAI({chain:true}).fetcher;
 try{await startDiscovery(env,testSettings,testSettings.campaigns[1]);for(let i=0;i<2;i++)await processAvailableJobs(env);assert.equal((await all(env,'SELECT * FROM leads')).length,0);assert.equal((await one<any>(env,'SELECT outcome FROM discovery_candidates')).outcome,'needs_review');}finally{globalThis.fetch=original;close();}
});
test('full staged pipeline creates a sourced specific working pilot without external enrichment or sending',async()=>{
 const {env,close}=database();env.OPENAI_API_KEY='test';const original=globalThis.fetch,{fetcher,calls}=mockOpenAI();globalThis.fetch=fetcher;
 try{await run(env,'INSERT INTO settings(id,data) VALUES(1,?)',JSON.stringify(testSettings));const lead=await readyLead(env,{email:null});await scheduleResearch(env);
 for(let i=0;i<9;i++)await processAvailableJobs(env);
 const draft=await one<any>(env,'SELECT * FROM drafts'),fresh=await one<any>(env,'SELECT * FROM leads WHERE id=?',lead.id);
 assert.equal(draft.status,'pending');assert.equal(draft.quality_hold,'');assert.equal(draft.approved_hash,null);assert.equal(fresh.email,'buyer@pumps.example.com');assert.equal(fresh.contact_status,'publicly_sourced');assert.equal(fresh.verification,'manual');
 assert.equal((await all(env,'SELECT * FROM business_facts')).length,2);assert.equal((await all(env,'SELECT * FROM research_claims')).length,1);
 assert.equal((await all(env,"SELECT * FROM expenses WHERE provider<>'openai'")).length,0);assert.equal((await all(env,'SELECT * FROM messages')).length,0);assert.equal(calls.length,6);
 assert.ok(calls.every(c=>c.store===false));assert.ok(calls.some(c=>c.tools?.[0].filters?.allowed_domains));
 }finally{globalThis.fetch=original;close();}
});
test('missing public email stays missing, and hallucinated addresses absent from the quoted report are rejected',async()=>{
 for(const options of [{noEmail:true},{badEmail:true}]){const {env,close}=database();env.OPENAI_API_KEY='test';const original=globalThis.fetch;globalThis.fetch=mockOpenAI(options).fetcher;
 try{const l=await readyLead(env,{email:null});const w={jobId:'contact-test',paidCalls:0};for(let step=0;step<5;step++){w.paidCalls=0;try{await researchContact(env,testSettings,l,w);break;}catch(error){if(!(error instanceof StageYield))throw error;}}const fresh=await one<any>(env,'SELECT * FROM leads');assert.equal(fresh.email,null);assert.notEqual(fresh.contact_status,'publicly_sourced');}finally{globalThis.fetch=original;close();}}
});
test('independent draft assessment holds generic pitches and does not send or approve them',async()=>{
 const {env,close}=database();env.OPENAI_API_KEY='test';const original=globalThis.fetch;globalThis.fetch=mockOpenAI({generic:true}).fetcher;
 try{await run(env,'INSERT INTO settings(id,data) VALUES(1,?)',JSON.stringify(testSettings));await readyLead(env);await scheduleResearch(env);for(let i=0;i<9;i++)await processAvailableJobs(env);const d=await one<any>(env,'SELECT * FROM drafts');assert.match(d.quality_hold,/generic/);assert.equal(d.status,'pending');}finally{globalThis.fetch=original;close();}
});
test('completed provider output replays without charging even after downstream persistence fails',async()=>{
 const {env,close}=database();env.OPENAI_API_KEY='test';const original=globalThis.fetch,{fetcher,calls}=mockOpenAI();globalThis.fetch=fetcher;
 try{const options={search:true,workflow:{jobId:'crash',paidCalls:0},stage:'search'};const a=await openai(env,testSettings,'business','research','ref',options);const b=await openai(env,testSettings,'business','research','ref',{...options,workflow:{jobId:'crash',paidCalls:0}});assert.deepEqual(a,b);assert.equal(calls.length,1);const row=await one<any>(env,'SELECT * FROM ai_attempts');assert.equal(row.request_id,'req_1');assert.equal(row.response_id,'resp_1');assert.equal((await all(env,'SELECT * FROM expenses')).length,1);}finally{globalThis.fetch=original;close();}
});
test('unknown paid requests retain reservation and cannot be silently replayed',async()=>{
 const {env,close}=database();env.OPENAI_API_KEY='test';const original=globalThis.fetch;let calls=0;globalThis.fetch=(async()=>{calls++;throw Error('lost acknowledgement');}) as typeof fetch;
 try{for(let i=0;i<2;i++)await assert.rejects(openai(env,testSettings,'x','x','ref',{search:true,workflow:{jobId:'uncertain',paidCalls:0},stage:'search'}),UncertainProviderError);assert.equal(calls,1);assert.equal((await one<any>(env,'SELECT state FROM expenses')).state,'uncertain');}finally{globalThis.fetch=original;close();}
});

test('a deliberate retry repairs malformed saved extraction once without repeating discovery',async()=>{
 const {env,close}=database();env.OPENAI_API_KEY='test';const original=globalThis.fetch;let calls=0;const requests:any[]=[];
 globalThis.fetch=(async(_url:any,init?:RequestInit)=>{calls++;requests.push(JSON.parse(String(init?.body)));return Response.json({id:'repair-'+calls,status:'completed',usage:{input_tokens:100,output_tokens:50},output:[{type:'message',content:[{type:'output_text',text:calls===1?'invalid JSON':JSON.stringify({email:''})}]}]});}) as typeof fetch;
 const schema={type:'object',additionalProperties:false,required:['email'],properties:{email:{type:'string'}}};
 try{const options={schema,stage:'contact_extract',workflow:{jobId:'repair-test',paidCalls:0}};const first=await openai(env,testSettings,'saved evidence','extract','repair',options);assert.throws(()=>JSON.parse(first.output[0].content[0].text));const repaired=await openai(env,testSettings,'saved evidence','extract','repair',{...options,workflow:{jobId:'repair-test',paidCalls:0,retryVersion:1}});assert.deepEqual(JSON.parse(repaired.output[0].content[0].text),{email:''});await openai(env,testSettings,'saved evidence','extract','repair',{...options,workflow:{jobId:'repair-test',paidCalls:0,retryVersion:2}});assert.equal(calls,2);assert.ok(requests.every(r=>!r.tools));assert.equal((await all(env,"SELECT * FROM expenses WHERE state='settled'")).length,2);}finally{globalThis.fetch=original;close();}
});
test('search/open actions use billable search usage and leave known cost settled',async()=>{
 const {env,close}=database();env.OPENAI_API_KEY='test';const original=globalThis.fetch;globalThis.fetch=(async()=>Response.json({status:'completed',usage:{input_tokens:100,output_tokens:100},tool_usage:{web_search:{num_requests:1}},output:[{type:'web_search_call',action:{type:'search'}},{type:'web_search_call',action:{type:'open_page',url:'https://example.com'}}]})) as typeof fetch;
 try{await openai(env,testSettings,'x','x','ref',{search:true,workflow:{jobId:'usage',paidCalls:0},stage:'search'});const e=await one<any>(env,'SELECT * FROM expenses');assert.equal(e.state,'settled');assert.ok(Math.abs(e.actual-(0.01+0.000075+0.00045))<1e-9);}finally{globalThis.fetch=original;close();}
});
test('shared budget reservations pause before fetch, including existing expenses and reply headroom',async()=>{
 const {env,close}=database();env.OPENAI_API_KEY='test';const original=globalThis.fetch;let calls=0;globalThis.fetch=(async()=>{calls++;throw Error('must not call');}) as typeof fetch;
 try{await run(env,"INSERT INTO expenses(id,provider,month,reserved,reference,created_at) VALUES('prior','openai',?,44.99,'old',?)",month(),now());await assert.rejects(openai(env,testSettings,'x','x','ref',{search:true,workflow:{jobId:'budget',paidCalls:0},stage:'search'}),BudgetPaused);assert.equal(calls,0);assert.equal((await all(env,'SELECT * FROM ai_attempts')).length,0);}finally{globalThis.fetch=original;close();}
});
test('registrable domain handling recognizes public suffixes without merging different businesses',()=>{assert.equal(domainOf('https://shop.example.co.uk/contact'),'example.co.uk');assert.notEqual(entityKey('North Pumps','https://example.co.uk','Leeds'),entityKey('South Pumps','https://example.co.uk','Leeds'));});
test('active runtime has no removed provider credentials or HTTP dependencies',()=>{
 for(const file of fs.readdirSync('src').filter(x=>x.endsWith('.ts'))){const s=fs.readFileSync('src/'+file,'utf8');assert.doesNotMatch(s,/api\.apify\.com|api\.hunter\.io|APIFY_TOKEN|HUNTER_API_KEY/);}
 assert.doesNotMatch(fs.readFileSync('public/app.js','utf8'),/Apify|Hunter/);
});

test('additive migration preserves sent history, owner edits, suppressions, approvals and legacy costs',()=>{
 const db=new DatabaseSync(':memory:');try{
  for(const f of fs.readdirSync('migrations').filter(x=>x.endsWith('.sql')&&x<'0006').sort())db.exec(fs.readFileSync('migrations/'+f,'utf8'));
  const at=now();db.prepare("INSERT INTO leads(id,company,email,created_at,updated_at) VALUES('keep','Owner business','owner@example.org',?,?)").run(at,at);
  db.prepare("INSERT INTO drafts(id,lead_id,kind,subject,body,status,version,approved_version,approved_hash,provider_id,created_at,updated_at) VALUES('draft','keep','initial','Owner subject','Owner edited body','sent',7,7,'approval','gmail-id',?,?)").run(at,at);
  db.prepare("INSERT INTO messages(id,lead_id,direction,subject,body,created_at) VALUES('gmail-id','keep','outbound','Owner subject','Owner edited body',?)").run(at);
  db.prepare("INSERT INTO suppressions VALUES('blocked@example.org','optout',?)").run(at);
  db.prepare("INSERT INTO expenses(id,provider,month,reserved,state,reference,created_at) VALUES('legacy','legacy-provider',?,1.5,'uncertain','prior-run',?)").run(month(),at);
  const tables=['drafts','messages','suppressions','expenses'];const before=tables.map(t=>db.prepare('SELECT * FROM '+t).all());
  db.exec(fs.readFileSync('migrations/0006_openai_pipeline.sql','utf8'));
  assert.deepEqual(tables.map(t=>db.prepare('SELECT * FROM '+t).all()),before);
  assert.equal(db.prepare("SELECT email FROM leads WHERE id='keep'").get()!.email,'owner@example.org');
 }finally{db.close();}
});

test('88 completed drafts never count as undrafted discovery backlog',async()=>{
 const {env,close}=database();env.OPENAI_API_KEY='test';env.ENABLE_AUTOMATION='true';const original=globalThis.fetch;globalThis.fetch=mockOpenAI().fetcher;
 try{await run(env,'INSERT INTO settings(id,data) VALUES(1,?)',JSON.stringify(testSettings));for(let i=0;i<88;i++){const l=await readyLead(env,{company:'Review '+i,email:`hello@review${i}.example.com`});const d=await readyDraft(env,l);await run(env,"UPDATE drafts SET status='pending' WHERE id=?",d.id);await run(env,"UPDATE leads SET status='review' WHERE id=?",l.id);}
 assert.equal(await researchBacklog(env),0);await tick(env);assert.equal((await all(env,'SELECT id FROM discovery_batches')).length,0);assert.equal((await all(env,"SELECT id FROM drafts WHERE status='pending'")).length,88);assert.equal((await all(env,'SELECT * FROM messages')).length,0);
 }finally{globalThis.fetch=original;close();}
});

test('several workflow stages claim a business only once per UTC day',async()=>{
 const {env,close}=database();try{const a=await readyLead(env),b=await readyLead(env,{company:'Other',email:'other@example.org'});for(let i=0;i<10;i++)assert.equal(await claimResearchBusiness(env,a.id,1),true);assert.equal(await claimResearchBusiness(env,b.id,1),false);assert.equal((await all(env,'SELECT * FROM research_claims')).length,1);}finally{close();}
});

test('month rollover never replays an uncertain paid attempt',async()=>{
 const {env,close}=database();env.OPENAI_API_KEY='test';const original=globalThis.fetch;let calls=0;globalThis.fetch=(async()=>{calls++;throw Error('lost');}) as typeof fetch;
 try{await assert.rejects(openai(env,testSettings,'x','x','ref',{search:true,workflow:{jobId:'old-month',paidCalls:0},stage:'search'}));await run(env,"UPDATE expenses SET month='2026-01'");await assert.rejects(openai(env,testSettings,'x','x','ref',{search:true,workflow:{jobId:'old-month',paidCalls:0},stage:'search'}),UncertainProviderError);assert.equal(calls,1);assert.equal((await one<any>(env,'SELECT month FROM expenses')).month,'2026-01');}finally{globalThis.fetch=original;close();}
});

test('the free-plan scheduled pipeline keeps D1 calls bounded across every research stage',async()=>{
 const {env,close}=database();Object.assign(env,{OPENAI_API_KEY:'test',GOOGLE_CLIENT_ID:'fixture',GOOGLE_CLIENT_SECRET:'fixture',GOOGLE_REFRESH_TOKEN:'fixture',ENABLE_AUTOMATION:'true',ENABLE_NOTIFICATIONS:'true',NOTIFY_EMAIL:'owner@example.org'});const original=globalThis.fetch,ai=mockOpenAI({maxFacts:true}).fetcher,google=mockGoogle(()=>Response.json({id:'notification'}));globalThis.fetch=((url:any,init?:RequestInit)=>String(url).includes('api.openai.com')?ai(url,init):google(url,init)) as typeof fetch;
 const raw=env.DB;let count=0;const unwrap=new WeakMap<object,any>();
 function wrap(statement:any):any{const result={bind:(...args:any[])=>wrap(statement.bind(...args)),first:(...args:any[])=>{count++;return statement.first(...args);},all:()=>{count++;return statement.all();},run:()=>{count++;return statement.run();}};unwrap.set(result,statement);return result;}
 env.DB={prepare:(sql:string)=>wrap(raw.prepare(sql)),batch:async(items:any[])=>{count+=items.length;return raw.batch(items.map(x=>unwrap.get(x)||x));}} as unknown as D1Database;
 try{await run(env,'INSERT INTO settings(id,data) VALUES(1,?)',JSON.stringify(testSettings));const requested=await readyLead(env);await enqueue(env,'research',requested.id,{manual:true});const counts=[];for(let i=0;i<12;i++){count=0;await tick(env);counts.push(count);}assert.ok(counts.every(n=>n<=50),JSON.stringify(counts));assert.equal((await all(env,'SELECT * FROM drafts')).length,1);}finally{globalThis.fetch=original;close();}
});

test('unrelated inbox messages are examined once rather than rescanned every scheduler cycle',async()=>{
 const {env,close}=database();Object.assign(env,{GOOGLE_CLIENT_ID:'fixture',GOOGLE_CLIENT_SECRET:'fixture',GOOGLE_REFRESH_TOKEN:'fixture'});const original=globalThis.fetch;let reads=0;
 globalThis.fetch=(async(url:any)=>{const u=String(url);if(u.includes('oauth2'))return Response.json({access_token:'fixture'});if(u.includes('messages?'))return Response.json({messages:[{id:'unrelated'}]});if(u.includes('messages/unrelated')){reads++;return Response.json({id:'unrelated',threadId:'unrelated-thread',payload:{headers:[{name:'From',value:'unrelated@example.org'}]}});}throw Error('Unexpected request');}) as typeof fetch;
 try{const a={processed:0},b={processed:0};await syncInbox(env,a);await syncInbox(env,b);assert.equal(reads,1);assert.equal(a.processed,1);assert.equal(b.processed,0);assert.equal((await all(env,'SELECT * FROM inbox_seen')).length,1);}finally{globalThis.fetch=original;close();}
});

test('approved dispatch and paid research use separate free-plan scheduler cycles',async()=>{
 const {env,close}=database();Object.assign(env,{OPENAI_API_KEY:'test',GOOGLE_CLIENT_ID:'fixture',GOOGLE_CLIENT_SECRET:'fixture',GOOGLE_REFRESH_TOKEN:'fixture',ENABLE_SENDING:'true'});
 const original=globalThis.fetch,{fetcher,calls}=mockOpenAI(),google=mockGoogle(()=>Response.json({id:'accepted-fixture',threadId:'fixture-thread'}));
 globalThis.fetch=((url:any,init?:RequestInit)=>String(url).includes('api.openai.com')?fetcher(url,init):google(url,init)) as typeof fetch;
 try{await run(env,'INSERT INTO settings(id,data) VALUES(1,?)',JSON.stringify(testSettings));const approved=await readyLead(env);await readyDraft(env,approved);await readyLead(env,{company:'Next business',email:'next@example.org'});await scheduleResearch(env);await tick(env);assert.equal((await all(env,"SELECT * FROM messages WHERE direction='outbound'")).length,1);assert.equal(calls.length,0);assert.ok((await all(env,"SELECT * FROM jobs WHERE state='pending'")).length);}finally{globalThis.fetch=original;close();}
});

test('queue, history and stage lookups use the intended migration indexes',()=>{
 const {sqlite,close}=database();try{
  for(const sql of ["SELECT id FROM jobs WHERE lead_id='x' AND state='pending'","SELECT id FROM drafts WHERE lead_id='x'","SELECT id FROM ai_attempts WHERE job_id='x' AND stage='search' AND state='complete' ORDER BY created_at DESC"]){const detail=sqlite.prepare('EXPLAIN QUERY PLAN '+sql).all().map((r:any)=>r.detail).join(' ');assert.match(detail,/USING (?:COVERING )?INDEX/);assert.doesNotMatch(detail,/SCAN (?:jobs|drafts|ai_attempts)/);}
 }finally{close();}
});
