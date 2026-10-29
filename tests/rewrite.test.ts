import {test} from 'node:test';
import assert from 'node:assert/strict';
import {database,readyLead,readyDraft,testSettings} from './helpers';
import {draftLead} from '../src/research';
import {run,one,now} from '../src/db';
import {pilotBody as body,pilotOffer} from './pilot-fixture';
import {linkedIn} from '../src/offers';
const sources=['https://pumps.example.com/catalogue','https://pumps.example.com/contact','https://directory.example.org/pumps'];
const output={qualified:true,holdReason:'',score:90,opportunity:'Recover stalled flange quotes',subject:'Recovering flange quotes',body,artifact:'Unexpected appendix must never be attached',evidence:sources.slice(0,2).map(url=>({url,kind:'observed',observation:'DIN pump flanges with enquiry details',relevance:'Quote follow-up'})),warnings:[],contactEmail:'',contactSource:'',freeOffer:pilotOffer};
for(const concurrentEdit of [false,true])test(concurrentEdit?'rewrite never overwrites edits made while the provider is running':'rewrite embeds a sourced free offer and clears the separate appendix',async()=>{
 const {env,close}=database(),original=globalThis.fetch;env.OPENAI_API_KEY='test';try{
  const lead=await readyLead(env);lead.research=JSON.stringify({report:'Catalogue lists DIN pump flanges; enquiry page requests dimensions.',sources:sources.map(url=>({url,title:'Source'})),gatheredAt:now()});
  const d=await readyDraft(env,lead);await run(env,"UPDATE drafts SET status='pending' WHERE id=?",d.id);
  globalThis.fetch=(async()=>{if(concurrentEdit)await run(env,"UPDATE drafts SET body='Owner edited text',version=version+1 WHERE id=?",d.id);return Response.json({status:'completed',usage:{input_tokens:100,output_tokens:100},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(output)}]}]});}) as typeof fetch;
  await draftLead(env,testSettings,lead,'initial',undefined,{id:d.id,version:d.version});const updated=await one<any>(env,'SELECT * FROM drafts WHERE id=?',d.id);
  assert.equal(updated.version,2);assert.equal(updated.status,'pending');
  if(concurrentEdit)assert.equal(updated.body,'Owner edited text');else{assert.match(updated.body,/free 30-day pilot/);assert.match(updated.body,/12\+ years/);assert.match(updated.body,/currently work at Adobe/);assert.ok(updated.body.includes(linkedIn));assert.ok(updated.body.indexOf('Adobe')<updated.body.indexOf('Your catalogue'));assert.ok(updated.body.split(/\s+/).length<160);assert.equal(updated.artifact,'');assert.equal(updated.quality_hold,'');assert.equal(updated.approved_hash,null);assert.equal(JSON.parse(updated.free_offer).sourceUrl,sources[0]);assert.equal(JSON.parse(updated.free_offer).version,'working-pilot-v2');}
 }finally{globalThis.fetch=original;close();}
});
