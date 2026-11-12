import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index';
import {database,testSettings,readyLead} from './helpers';
import {all,one,run,settings,now,day,claimResearchBusiness} from '../src/db';
import {saveProduct,product,scopeProduct} from '../src/products';
import {startDiscovery} from '../src/discovery';
import {tick} from '../src/engine';
import {fixtureUseCase,mockOpenAI} from './openai-fixture';

async function setup(extra:any={}){
 const db=database();Object.assign(db.env,{OPENAI_API_KEY:'mock',ENABLE_AUTOMATION:'true',AI_STAGES_PER_CYCLE:'3'});
 const p=await saveProduct(db.env,{name:'Manual demo',website:'https://product.example.org',description:'Quotation specifications',sender_email:'data@prepyr.com'});
 await run(db.env,"UPDATE products SET state='approved',approved_revision=revision,analysis=? WHERE id=?",JSON.stringify({useCases:[fixtureUseCase]}),p.id);
 const scope=await scopeProduct(db.env,await product(db.env,p.id));
 await run(scope,'UPDATE settings SET data=?',JSON.stringify({...testSettings,campaigns:[{query:'pump suppliers',location:'London, UK',country:'GB',timezone:'Europe/London',enabled:true}],...extra}));
 const ctx={waitUntil:()=>{}} as unknown as ExecutionContext,base=db.env.APP_URL!;
 const req=async(path:string,body?:any,cookie='')=>worker.fetch(new Request(base+path,{method:body===undefined?'GET':'POST',headers:{Origin:base,'X-Requested-With':'Prepyr',Cookie:cookie},...(body===undefined?{}:{body:JSON.stringify(body)})}),db.env,ctx);
 const login=await req('/api/login',{password:db.env.ADMIN_PASSWORD}),cookie=login.headers.get('set-cookie')!.split(';')[0];
 const manual=()=>req('/api/discover?product='+p.id,{},cookie);
 return {...db,p,scope,manual,req,cookie};
}

test('Find prospects ignores retired campaign intervals and retains the current profile',async()=>{
 const x=await setup();try{
  await run(x.scope,'INSERT INTO discovery_cycles(id,created_at,completed_at,product_revision,target) VALUES(?,?,?,?,12)','finished',now(),now(),1);
  const before=await settings(x.scope);assert.equal((await startDiscovery(x.scope,before,undefined,undefined,false)).state,'manual_only');
  const response=await x.manual();assert.equal(response.status,200);assert.equal((await response.json() as any).state,'queued');
  assert.equal(JSON.parse((await one<any>(x.scope,"SELECT payload FROM jobs WHERE kind='discover_search'"))!.payload).manual,true);
  assert.equal((await settings(x.scope)).discoveryPaused,undefined);assert.equal((await product(x.env,x.p.id)).approved_revision,1);
  assert.equal((await all(x.scope,'SELECT * FROM discovery_cycles')).length,2);assert.equal((await all(x.scope,'SELECT * FROM ai_attempts')).length,0);
 }finally{x.close();}
});

test('a manual request remains available during an automatic-only pause and timed hold; its queued job executes',async()=>{
 const x=await setup({discoveryPaused:true,discoveryPausedUntil:new Date(Date.now()+6*86400000).toISOString()}),original=globalThis.fetch,ai=mockOpenAI();globalThis.fetch=ai.fetcher;
 try{const before=await settings(x.scope);assert.equal((await startDiscovery(x.scope,before,undefined,undefined,false)).state,'manual_only');assert.equal((await x.manual()).status,200);await tick(x.scope);assert.ok(ai.calls.length>0);assert.equal((await settings(x.scope)).discoveryPaused,undefined);assert.equal((await settings(x.scope)).discoveryPausedUntil,undefined);}finally{globalThis.fetch=original;x.close();}
});

test('explicit manual search and its research finish when automatic research is off, without starting unrelated work',async()=>{
 const x=await setup({researchAutomation:false,discoveryPaused:true}),original=globalThis.fetch,ai=mockOpenAI();globalThis.fetch=ai.fetcher;
 try{const unrelated=await readyLead(x.scope,{company:'Unrelated candidate',email:'unrelated@example.org',website:'https://unrelated.example.org'});assert.equal((await x.manual()).status,200);for(let i=0;i<12;i++)await tick(x.scope);
  assert.equal((await all(x.scope,'SELECT * FROM drafts')).length,1);assert.equal((await all(x.scope,'SELECT * FROM jobs WHERE lead_id=?',unrelated.id)).length,0);
  assert.equal((await settings(x.scope)).researchAutomation,undefined);assert.equal((await settings(x.scope)).discoveryPaused,undefined);assert.equal((await all(x.scope,'SELECT * FROM messages')).length,0);
 }finally{globalThis.fetch=original;x.close();}
});

test('repeated clicks return the active search rather than creating duplicate batches',async()=>{
 const x=await setup();try{const a=await(await x.manual()).json() as any,b=await(await x.manual()).json() as any;assert.equal(a.runId,b.runId);assert.equal((await all(x.scope,'SELECT * FROM discovery_batches')).length,1);assert.equal((await all(x.scope,'SELECT * FROM ai_attempts')).length,0);}finally{x.close();}
});

test('simultaneous manual requests cannot queue duplicate paid searches',async()=>{
 const x=await setup();try{const requests=await Promise.all([x.manual(),x.manual()]);assert.ok(requests.every(r=>[200,409].includes(r.status)));assert.equal((await all(x.scope,'SELECT * FROM discovery_batches')).length,1);assert.equal((await all(x.scope,"SELECT * FROM jobs WHERE kind='discover_search'")).length,1);}finally{x.close();}
});

test('a new search is not blocked by legacy daily research usage',async()=>{
 const x=await setup({dailyResearchLimit:1});try{await claimResearchBusiness(x.scope,'used',1);const r=await(await x.manual()).json() as any;assert.equal(r.state,'queued');assert.equal((await all(x.scope,'SELECT * FROM discovery_batches')).length,1);}finally{x.close();}
});

test('manual search ignores unrelated candidates while recurring discovery stays disabled',async()=>{
 const x=await setup();try{await readyLead(x.scope);assert.equal((await startDiscovery(x.scope,await settings(x.scope),undefined,undefined,false)).state,'manual_only');assert.equal((await(await x.manual()).json() as any).state,'queued');}finally{x.close();}
});

test('editing targets never causes a manual click to search with a stale, unapproved profile',async()=>{
 const x=await setup();try{const r=await x.req('/api/settings/preferences?product='+x.p.id,{...await settings(x.scope),customerDescription:'New target customers'},x.cookie);assert.equal(r.status,200);const response=await x.manual();assert.equal(response.status,200);assert.equal((await response.json() as any).state,'profiling');assert.equal((await product(x.env,x.p.id)).approved_revision,null);assert.equal((await all(x.scope,'SELECT * FROM discovery_batches')).length,0);}finally{x.close();}
});

test('manual search ignores legacy workspace and global pause flags',async()=>{
 const x=await setup({prospectingPaused:true});try{assert.equal((await x.manual()).status,200);await run(x.scope,"UPDATE settings SET data=json_set(data,'$.prospectingPaused',json('false'))");await run(x.env,'INSERT INTO settings VALUES(1,?)',JSON.stringify({...testSettings,outreachPaused:true}));assert.equal((await x.manual()).status,200);assert.equal((await all(x.scope,'SELECT * FROM discovery_batches')).length,1);}finally{x.close();}
});
