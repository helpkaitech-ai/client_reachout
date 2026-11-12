import {test} from 'node:test';
import assert from 'node:assert/strict';
import {database,testSettings} from './helpers';
import {mockOpenAI} from './openai-fixture';
import {all,one,run,settings,now,day} from '../src/db';
import {startDiscovery} from '../src/discovery';
import {tick,tickWorkspaces} from '../src/engine';
import {saveProduct,scopeProduct,product,requestProductDiscovery} from '../src/products';

test('cron never creates searches even when legacy automation and interval settings are enabled',async()=>{
 const x=database();Object.assign(x.env,{OPENAI_API_KEY:'mock',ENABLE_AUTOMATION:'true'});
 try{
  await run(x.env,'INSERT INTO settings VALUES(1,?)',JSON.stringify({...testSettings,researchAutomation:true,discoveryPaused:false,discoveryIntervalDays:1}));
  for(let i=0;i<4;i++)await tickWorkspaces(x.env);
  assert.equal((await all(x.env,'SELECT * FROM jobs')).length,0);
  assert.equal((await startDiscovery(x.env,await settings(x.env),undefined,undefined,false)).state,'manual_only');
  assert.equal((await all(x.env,'SELECT * FROM discovery_batches')).length,0);
 }finally{x.close();}
});

test('one product search request generates and applies its profile and then queues discovery without another click',async()=>{
 const x=database(),original=globalThis.fetch,ai=mockOpenAI();Object.assign(x.env,{OPENAI_API_KEY:'mock',AI_STAGES_PER_CYCLE:'3'});globalThis.fetch=ai.fetcher;
 try{
  const p=await saveProduct(x.env,{name:'Pump product',website:'https://pumps.example.com',description:'Quotation workflow product',sender_email:'data@prepyr.com'});
  const scope=await scopeProduct(x.env,p);assert.equal((await settings(scope)).prospectingPaused,undefined);
  assert.equal((await requestProductDiscovery(scope))?.state,'profiling');assert.equal(ai.calls.length,0);
  for(let i=0;i<4;i++)await tickWorkspaces(x.env);
  const fresh=await product(x.env,p.id);assert.equal(fresh.state,'approved');assert.equal(fresh.approved_revision,fresh.revision);
  assert.equal((await all(scope,'SELECT * FROM discovery_batches')).length,1);
  assert.equal(ai.calls.filter(c=>c.text?.format?.name==='relay_product_extract').length,1);
  assert.equal((await all(scope,'SELECT * FROM messages')).length,0);
 }finally{globalThis.fetch=original;x.close();}
});

test('unfinished manual searches expire at the day boundary and cannot restart until another click',async()=>{
 const x=database(),original=globalThis.fetch,ai=mockOpenAI();x.env.OPENAI_API_KEY='mock';globalThis.fetch=ai.fetcher;
 try{
  await startDiscovery(x.env,testSettings);
  const yesterday=new Date(Date.parse(day()+'T00:00:00Z')-86400000).toISOString();
  await run(x.env,'UPDATE discovery_cycles SET created_at=?',yesterday);
  await run(x.env,'UPDATE discovery_batches SET created_at=?',yesterday);
  await run(x.env,"UPDATE jobs SET created_at=?,payload=json_set(payload,'$.campaignDay',?)",yesterday,yesterday.slice(0,10));
  for(let i=0;i<3;i++)await tick(x.env);
  assert.equal(ai.calls.length,0);assert.equal((await one<any>(x.env,'SELECT state FROM jobs'))!.state,'cancelled');
  assert.equal((await all(x.env,'SELECT * FROM discovery_batches')).length,1);
  assert.equal((await startDiscovery(x.env,testSettings)).state,'queued');
  assert.equal((await all(x.env,'SELECT * FROM discovery_cycles')).length,2);
 }finally{globalThis.fetch=original;x.close();}
});

test('new products retain independent targets and research capacity without a workspace pause',async()=>{
 const x=database();try{
  await run(x.env,'INSERT INTO settings VALUES(1,?)',JSON.stringify({...testSettings,prospectingPaused:true}));
  const p=await saveProduct(x.env,{name:'Product',website:'https://pumps.example.com',description:'Quote product',sender_email:'data@prepyr.com'}),s=await settings(await scopeProduct(x.env,p));
  assert.equal(s.prospectingPaused,undefined);assert.equal(s.discoveryPaused,undefined);assert.equal(s.dailyLeadLimit,12);assert.equal(s.dailyResearchLimit,60);
  assert.equal((await settings(x.env)).prospectingPaused,undefined);
 }finally{x.close();}
});

test('legacy automatic cycles cannot create replacement searches after recurring discovery is retired',async()=>{
 const x=database();x.env.OPENAI_API_KEY='mock';
 try{
  await startDiscovery(x.env,testSettings);
  await run(x.env,"UPDATE jobs SET payload=json_set(payload,'$.manual',json('false')),state='complete'");
  await run(x.env,"UPDATE discovery_batches SET state='complete'");
  await tick(x.env);await tick(x.env);
  assert.equal((await all(x.env,'SELECT * FROM discovery_batches')).length,1);
  assert.equal((await startDiscovery(x.env,testSettings)).state,'queued');
  assert.equal((await all(x.env,'SELECT * FROM discovery_cycles')).length,2);
 }finally{x.close();}
});

test('manual-mode migration unpauses research without dispatching older email approvals or losing history',async()=>{
 const x=database();try{
  const {readFileSync}=await import('node:fs');
  const {readyLead,readyDraft}=await import('./helpers');
  const draft=await readyDraft(x.env,await readyLead(x.env));
  const sent=await readyDraft(x.env,await readyLead(x.env,{company:'Sent history',email:'sent@example.org'}));
  await run(x.env,"UPDATE drafts SET status='sent' WHERE id=?",sent.id);
  await run(x.env,'INSERT INTO settings VALUES(1,?)',JSON.stringify({...testSettings,outreachPaused:true,prospectingPaused:true,dailyResearchLimit:20,openaiBudget:7}));
  x.sqlite.exec(readFileSync('migrations/0012_manual_discovery.sql','utf8'));
  const s=await settings(x.env);assert.equal(s.outreachPaused,undefined);assert.equal(s.prospectingPaused,undefined);assert.equal(s.dailyResearchLimit,60);assert.equal(s.openaiBudget,7);
  const updated=await one<any>(x.env,'SELECT * FROM drafts WHERE id=?',draft.id);
  assert.equal(updated.status,'pending');assert.equal(updated.approved_hash,null);assert.equal(updated.body,draft.body);
  assert.equal((await one<any>(x.env,'SELECT status FROM drafts WHERE id=?',sent.id))!.status,'sent');
 }finally{x.close();}
});
