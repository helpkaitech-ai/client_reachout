import {test} from 'node:test';
import assert from 'node:assert/strict';
import {database,testSettings} from './helpers';
import {actorInput,profilePages,linkedinDiscovery,apifyRequest} from '../src/apify';
import {run,one,now} from '../src/db';
import {StageYield} from '../src/ai';
import {UncertainProviderError} from '../src/providers';

const campaign={query:'operations analysis',location:'Austin, Texas, USA',country:'US',timezone:'America/Chicago',enabled:true};
const profile={linkedinUrl:'https://www.linkedin.com/in/example-person',firstName:'Example',lastName:'Person',headline:'Operations lead',about:'I analyze customer orders and inventory trends to guide operational decisions.',experience:[{position:'Operations lead',companyName:'Example Startup',description:'Analyze orders and inventory data.',endDate:{text:'Present'}}],email:'hidden-enriched@example.com',education:[{school:'Do not retain'}]};
test('actor input is bounded and does not silently constrain size, industry or founder status',()=>{
 const input=actorInput({searchQuery:'startup',currentJobTitles:['Operations Manager']},campaign,0);
 assert.equal(input.locations[0],'Austin, United States');assert.equal(input.profileScraperMode,'Full');assert.equal(input.maxItems,25);assert.equal(input.takePages,1);assert.equal(input.autoQuerySegmentation,false);assert.equal(actorInput({searchQuery:'startup lead conversion',currentJobTitles:['Sales Operations Manager']},campaign,99,['startups']).searchQuery,'startup');assert.equal(actorInput({searchQuery:'startup',currentJobTitles:[]},campaign,99).startPage,1);const seeded=actorInput({searchQuery:'startup',currentJobTitles:['Operations Manager']},campaign,0,['startups'],['https://www.linkedin.com/company/example-startup']);assert.equal(seeded.searchQuery,'');assert.deepEqual(seeded.currentCompanies,['https://www.linkedin.com/company/example-startup']);assert.equal('companyHeadcount' in input,false);assert.equal('industryIds' in input,false);
});
test('actor snapshots retain public professional evidence and provenance, not enriched emails or education',()=>{
 const [page]=profilePages([profile,{...profile,linkedinUrl:'https://evil.test/in/example'}],'run123');assert.equal(page.providerRunId,'run123');assert.match(page.text,/Analyze orders/);assert.doesNotMatch(page.text,/hidden-enriched|Do not retain/);assert.equal(profilePages([{...profile,linkedinUrl:'https://linkedin.com.evil.test/in/x'}],'run').length,0);
});
test('Apify token travels in Authorization only and provider error bodies cannot leak it',async()=>{
 const x=database(),old=globalThis.fetch;x.env.APIFY_TOKEN='secret-fixture';globalThis.fetch=async(url,init)=>{assert.equal(init!.redirect,'manual');assert.ok(!String(url).includes('secret-fixture'));assert.equal((init!.headers as any).Authorization,'Bearer secret-fixture');return new Response('secret-fixture',{status:401});};
 try{await assert.rejects(apifyRequest(x.env,'users/me'),e=>e instanceof Error&&/HTTP 401/.test(e.message)&&!e.message.includes('secret-fixture'));}finally{globalThis.fetch=old;x.close();}
});
test('hybrid selection fails visibly without token; OpenAI mode never calls Apify',async()=>{
 const x=database();try{assert.deepEqual(await linkedinDiscovery(x.env,testSettings,'j',campaign,{jobId:'j',paidCalls:0}),[]);await assert.rejects(linkedinDiscovery(x.env,{...testSettings,discoveryProvider:'hybrid'},'j',campaign,{jobId:'j',paidCalls:0}),/APIFY_TOKEN/);}finally{x.close();}
});
test('uncertain submission is never blindly replayed',async()=>{
 const x=database(),old=globalThis.fetch;x.env.APIFY_TOKEN='fixture';let calls=0;globalThis.fetch=async()=>{calls++;throw Error('should not call');};
 try{await run(x.env,'INSERT INTO pipeline_results VALUES(?,?,?)','j:apify',JSON.stringify({state:'submitting',expenseId:'e',startedAt:now()}),now());await assert.rejects(linkedinDiscovery(x.env,{...testSettings,discoveryProvider:'hybrid'},'j',campaign,{jobId:'j',paidCalls:0}),UncertainProviderError);assert.equal(calls,0);}finally{globalThis.fetch=old;x.close();}
});
test('running actor yields then reads one bounded dataset and reuses its completed checkpoint',async()=>{
 const x=database(),old=globalThis.fetch;x.env.APIFY_TOKEN='fixture';let complete=false,calls:string[]=[];
 globalThis.fetch=async url=>{const u=String(url);calls.push(u);if(u.includes('actor-runs/run123'))return Response.json({data:{id:'run123',status:complete?'SUCCEEDED':'RUNNING',defaultDatasetId:'dataset123',usageTotalUsd:0.2}});if(u.includes('datasets/dataset123/items?clean=true&limit=25'))return Response.json([profile]);throw Error('unexpected call');};
 try{await run(x.env,'INSERT INTO pipeline_results VALUES(?,?,?)','j:apify',JSON.stringify({state:'running',expenseId:'e',runId:'run123',startedAt:now()}),now());const s={...testSettings,discoveryProvider:'hybrid' as const};await assert.rejects(linkedinDiscovery(x.env,s,'j',campaign,{jobId:'j',paidCalls:0}),StageYield);complete=true;assert.equal((await linkedinDiscovery(x.env,s,'j',campaign,{jobId:'j',paidCalls:0})).length,1);const n=calls.length;assert.equal((await linkedinDiscovery(x.env,s,'j',campaign,{jobId:'j',paidCalls:0})).length,1);assert.equal(calls.length,n);assert.equal(JSON.parse((await one<any>(x.env,'SELECT data FROM pipeline_results WHERE job_id=?','j:apify')).data).state,'complete');}finally{globalThis.fetch=old;x.close();}
});
