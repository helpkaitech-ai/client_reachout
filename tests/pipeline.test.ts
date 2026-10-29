import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database,readyLead,testSettings } from './helpers';
import { draftLead, recipientGreeting, specificOfferProblem } from '../src/research';
import { all,one } from '../src/db';
import { startDiscovery } from '../src/discovery';
import type { Lead } from '../src/types';
import { syncInbox } from '../src/mail';
import { scheduleResearch, processAvailableJobs } from '../src/engine';
import { run } from '../src/db';
import {pilotBody,pilotOffer} from './pilot-fixture';

test('free offer must be inline and tied to a business detail from recorded research',()=>{
 const body=pilotBody,freeOffer=pilotOffer;
 const allowed=new Set([freeOffer.sourceUrl]);assert.equal(specificOfferProblem({body,freeOffer},allowed),'');
 assert.ok(specificOfferProblem({body:'I can offer a free audit.',freeOffer},allowed));
 assert.ok(specificOfferProblem({body,freeOffer:{...freeOffer,sourceUrl:'https://invented.example.com'}},allowed));
 assert.ok(specificOfferProblem({body,freeOffer:{...freeOffer,emailExcerpt:'I will provide a completely different free example for another company.'}},allowed));
});

test('draft salutations use a known recipient or business team, never the sender name',()=>{
 assert.equal(recipientGreeting('Hi Rushi,\n\nA specific quote improvement.',{company:'Centex',contact_name:''}),'Hi Centex team,\n\nA specific quote improvement.');
 assert.equal(recipientGreeting('Hello Rushi,\n\nA specific improvement.',{company:'Centex',contact_name:'Alex'}),'Hi Alex,\n\nA specific improvement.');
});

test('automation researches businesses with missing emails and recovers held prospects exactly once',async()=>{
 const {env,close}=database();try{const a=await readyLead(env,{email:null});await run(env,"UPDATE leads SET status='held' WHERE id=?",a.id);await scheduleResearch(env);await scheduleResearch(env);const jobs=await all<any>(env,'SELECT * FROM jobs');assert.equal(jobs.length,1);assert.equal(jobs[0].lead_id,a.id);assert.equal(jobs[0].kind,'research');}finally{close();}
});

test('multi-source research produces a tailored draft, free sample and auditable usage',async()=>{
 const {env,close}=database();env.OPENAI_API_KEY='test';const original=globalThis.fetch;let calls=0;
 const urls=['https://pumps.example.com/catalogue','https://pumps.example.com/enquiry','https://directory.example.org/pumps'];
 globalThis.fetch=(async(_url:any,init:any)=>{calls++;const req=JSON.parse(init.body);assert.equal(req.store,false);if(req.tools)return Response.json({status:'completed',usage:{input_tokens:2000,output_tokens:500},output:[{type:'web_search_call',action:{sources:urls.map(url=>({url,title:'Business source'}))}},{type:'message',content:[{type:'output_text',text:'The company catalogue lists pump specifications. The enquiry page has a general message field. Identity corroborated by directory. Quote structure is an opportunity, not proof of lost revenue.'}]}]});assert.ok(req.text.format.schema);return Response.json({status:'completed',usage:{input_tokens:3000,output_tokens:600},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({qualified:true,holdReason:'',score:82,opportunity:'Carry pump selection into enquiries',subject:'A sample quote form for your pumps',body:'Your catalogue lists the pump specifications, while your enquiry page uses a general message field. Here is a sample form tailored to the catalogue so buyers can include the information your team needs.',artifact:'Free sample: model selection, quantity, operating conditions. Synthetic example: model A, two units.',evidence:[{observation:'Catalogue has specifications',url:urls[0],kind:'observed',relevance:'Product context'},{observation:'Enquiry uses general field',url:urls[1],kind:'observed',relevance:'Opportunity'}],warnings:['Internal quotation handling is unknown.']})}]}]});}) as typeof fetch;
 try{const lead=await readyLead(env);await draftLead(env,testSettings,lead);const d=await one<any>(env,'SELECT * FROM drafts');assert.equal(d.status,'pending');assert.equal(d.approved_hash,null);assert.equal(d.artifact,'');assert.equal(calls,2);assert.equal((await all(env,"SELECT * FROM expenses WHERE state='settled'")).length,2);await draftLead(env,testSettings,(await one<Lead>(env,'SELECT * FROM leads WHERE id=?',lead.id))!);assert.equal(calls,2,'existing active draft prevents repeat paid work');}finally{globalThis.fetch=original;close();}
});
test('weak research gets a second pass and remains visible as a blocked draft',async()=>{
 const {env,close}=database();env.OPENAI_API_KEY='test';const original=globalThis.fetch;let calls=0;
 globalThis.fetch=(async(_url:any,init:any)=>{calls++;const request=JSON.parse(init.body);return Response.json({status:'completed',usage:{input_tokens:100,output_tokens:100},output:[...(request.tools?[{type:'web_search_call',action:{sources:[{url:'https://pumps.example.com',title:'Home'}]}}]:[]),{type:'message',content:[{type:'output_text',text:request.tools?'Insufficient evidence.':JSON.stringify({qualified:false,holdReason:'Identity is not corroborated',score:10,subject:'A possible enquiry improvement',body:'Working draft for review, pending confirmation of the business identity.',artifact:'Working enquiry field sample',evidence:[],warnings:['Needs stronger evidence'],contactEmail:'',contactSource:''})}]}]});}) as typeof fetch;
 try{const lead=await readyLead(env);await draftLead(env,testSettings,lead);assert.equal(calls,3);const draft=await one<any>(env,'SELECT * FROM drafts');assert.equal(draft.status,'pending');assert.match(draft.quality_hold,/not corroborated/);assert.equal((await one<any>(env,'SELECT status FROM leads WHERE id=?',lead.id)).status,'review');}finally{globalThis.fetch=original;close();}
});

test('inbox pagination persists and blocks sending until the backlog is caught up',async()=>{const {env,close}=database();Object.assign(env,{GOOGLE_CLIENT_ID:'x',GOOGLE_CLIENT_SECRET:'x',GOOGLE_REFRESH_TOKEN:'x'});const original=globalThis.fetch;globalThis.fetch=(async(url:any)=>{if(String(url).includes('oauth2'))return Response.json({access_token:'test'});return Response.json(String(url).includes('pageToken=next')?{messages:[]}:{messages:[],nextPageToken:'next'});}) as typeof fetch;try{assert.equal(await syncInbox(env),false);assert.equal(await syncInbox(env),true);const cursor=JSON.parse((await one<any>(env,"SELECT value FROM integration_state WHERE key='inbox_cursor'")).value);assert.equal(cursor.page,'');assert.equal(cursor.before,0);}finally{globalThis.fetch=original;close();}});
