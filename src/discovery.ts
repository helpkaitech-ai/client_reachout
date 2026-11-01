import type {Env,Settings,Campaign,Job} from './types';
import {all,now,one,run,uid,audit,acquire,release} from './db';
import {nextCampaign,nextProductCampaign,type SearchHistory} from './locations';
import {openai,outputText} from './providers';
import {StageYield,type Workflow} from './ai';
import {collectSources,listedSource,objectSchema,textField as str,researchSecurity,containsExcerpt,productQualificationPolicy} from './evidence';
import {entityKey,importLead} from './leads';
import {publicUrl} from './policy';
import {requireProductReady} from './products';
import {assertProspectingRunning} from './outreach-control';
import {assertProviderAvailable} from './provider-control';
import {prepareDiscoveryCycle} from './discovery-cycles';
export {importLead} from './leads';
export function discoveryPause(s:Settings){return Date.parse(s.discoveryPausedUntil||'')>Date.now()?s.discoveryPausedUntil:null;}

const candidateSchema=objectSchema({candidates:{type:'array',maxItems:10,items:objectSchema({company:str,website:str,city:str,country:str,description:str,industry:str,independence:{type:'string',enum:['independent','chain','unknown']},size:{type:'string',enum:['small_or_midsize','large','unknown']},fitEvidence:str,sourceUrl:str,evidenceExcerpt:str})}});
const productCandidates=objectSchema({candidates:{type:'array',maxItems:10,items:objectSchema({company:str,contact_name:str,website:str,city:str,country:str,description:str,industry:str,targetMatch:{type:'boolean'},contactScope:{type:'string',enum:['organization','public_professional','private_consumer']},sensitivePersonalTarget:{type:'boolean'},fitEvidence:str,sourceUrl:str,evidenceExcerpt:str})}});
export async function searchHistory(env:Env){return all<SearchHistory>(env,"SELECT json_extract(campaign,'$.location') location,json_extract(campaign,'$.country') country,COUNT(*) uses,MAX(created_at) last_used FROM discovery_batches GROUP BY location,country");}
export async function startDiscovery(env:Env,s:Settings,selected?:Campaign,intent?:string,manual=false,continuation=false){
 const owner=await acquire(env,'discovery-enqueue',60);
 if(!owner)return {state:'queued',runId:undefined,message:'A prospect search request is already being queued. Results appear automatically.'};
 try{return await enqueueDiscovery(env,s,selected,intent,manual,continuation);}finally{await release(env,'discovery-enqueue',owner);}
}
async function enqueueDiscovery(env:Env,s:Settings,selected:Campaign|undefined,intent:string|undefined,manual:boolean,continuation:boolean){
 requireProductReady(env);
 if(s.discoveryPaused&&!manual)return {state:'paused',message:'Automatic discovery is paused. Find prospects can request a manual search.'};
 if(!env.OPENAI_API_KEY)throw new Error('Configure OpenAI before finding prospects');
 const resumeAt=discoveryPause(s);if(resumeAt&&!manual)return {state:'paused',resumeAt,message:`Automatic prospect searches are paused until ${resumeAt}. Find prospects can request a manual search.`};
 const active=await one<any>(env,"SELECT * FROM discovery_batches WHERE state IN ('queued','running','budget_paused') ORDER BY created_at LIMIT 1");
 if(active&&(!intent||env.PRODUCT_ID))return {state:active.state,runId:active.id,message:'Your prospect search is already queued or running. Results appear automatically.'};
 if(env.PRODUCT_ID)await assertProspectingRunning(env);
 const cycle=env.PRODUCT_ID?await prepareDiscoveryCycle(env,s,manual,continuation):null;
 const reasons={cooldown:'The automatic campaign is waiting for the configured interval. Find prospects starts a manual search without that wait.',daily_target:`This workspace has reached its ${Math.min(s.dailyLeadLimit,s.dailyNewLimit)} qualified-email limit for today. The daily allowance resets at 00:00 UTC.`,research_limit:`This workspace has used or queued its ${s.dailyResearchLimit} research slots for today. The daily allowance resets at 00:00 UTC.`,researching:'Existing candidates are being researched. Find prospects can request another manual batch within the remaining allowance.',search_limit:'The automatic search allowance for today has been reached. Find prospects can request another manual search within the remaining research and budget limits.'};
 if(cycle&&cycle.state!=='ready')return {state:cycle.state,message:reasons[cycle.state]};
 const last=await one<any>(env,'SELECT created_at FROM discovery_batches ORDER BY created_at DESC LIMIT 1');
 if(!manual&&!env.PRODUCT_ID&&!selected&&last&&Date.now()-Date.parse(last.created_at)<s.discoveryIntervalDays*86400000)return {state:'cooldown',message:'The next automatic search starts after the configured interval. Find prospects overrides that wait.'};
 if(!env.PRODUCT_ID)await assertProspectingRunning(env);
 await assertProviderAvailable(env);
 const history=await searchHistory(env),choices=s.campaigns.filter(c=>c.enabled);
 const base=selected||(env.PRODUCT_ID?nextProductCampaign(s,history):nextCampaign(s,history));
 if(!base)throw new Error('The approved customer profile has no enabled search campaigns');
 const searchAngle=['local specialist businesses with an official service catalogue','independent trade association members with an official business website','owner-operated service companies with a concrete booking or quotation workflow'][history.reduce((n,h)=>n+h.uses,0)%3];
 const campaign={...base,searchAngle:env.PRODUCT_ID?'Follow the owner-approved product targeting and remarks':searchAngle},id=intent||uid(),jobId='discovery:'+id,at=now();
 await env.DB.batch([
  env.DB.prepare('INSERT OR IGNORE INTO discovery_batches(id,job_id,campaign,created_at,updated_at) VALUES(?,?,?,?,?)').bind(id,jobId,JSON.stringify(campaign),at,at),
  env.DB.prepare("INSERT OR IGNORE INTO jobs(id,kind,payload,created_at,updated_at) VALUES(?,'discover_search',?,?,?)").bind(jobId,JSON.stringify({batchId:id,campaign,manual,maximumCandidates:cycle?.state==='ready'?cycle.capacity:Math.min(10,s.discoveryResults)}),at,at),
  ...(cycle?.state==='ready'?[env.DB.prepare('INSERT OR IGNORE INTO discovery_cycle_batches(batch_id,cycle_id) VALUES(?,?)').bind(id,cycle.cycleId)]:[])
 ]);
 return {state:'queued',runId:id,message:`Searching for independent businesses in ${campaign.location}. Public sources and emails will be researched before review.`};
}
export async function runDiscovery(env:Env,s:Settings,job:Job,w:Workflow){
 requireProductReady(env);
 const p=JSON.parse(job.payload),batch=await one<any>(env,'SELECT * FROM discovery_batches WHERE id=?',p.batchId);if(!batch)throw new Error('Search batch not found');
 const campaign:Campaign=JSON.parse(batch.campaign);
 await run(env,"UPDATE discovery_batches SET state='running',error=NULL,updated_at=? WHERE id=?",now(),batch.id);
 const maximumCandidates=Math.min(10,s.discoveryResults,p.maximumCandidates||10);
 const report=await openai(env,s,JSON.stringify({campaign,maximumCandidates,excludedDomains:(await all<any>(env,"SELECT DISTINCT domain FROM leads WHERE domain<>'' ORDER BY created_at DESC LIMIT 200")).map(x=>x.domain)}),`${researchSecurity}
 ${env.PRODUCT_ID?productQualificationPolicy:''}
 ${env.PRODUCT_ID?'Find real businesses that match the approved PRODUCT customer profile and owner remarks. Determine fit using this product, not a fixed industry, size or chain/independence rule. Explain each match using sourced business facts and the product value proposition.':'Find real independent small or midsize businesses matching this service and city/country. Exclude national/international chains.'} Prefer businesses with an openly listed, appropriate business contact email on their official contact page or a corroborated public profile. Use contactability as a discovery priority alongside the approved customer fit; never guess addresses or substitute privacy, jobs or no-reply mailboxes. Search public business sites, trade associations and directories. Exclude directories posing as companies and closed businesses. Give fewer results rather than padding. Establish each business's official website, actual service, city/country and target fit only where supported. Provide exact source URLs and brief evidence excerpts. Do not invent employee/revenue figures or contact addresses. This is discovery, not an outreach message. Avoid excluded domains where practical; do not pretend exclusions guarantee uniqueness.`,batch.id+':search',{search:true,workflow:w,stage:'discover_search',maxTools:4,maxOutput:3500,location:{country:campaign.country,city:campaign.location.split(',')[0]}});
 const sources=collectSources(report);
 const extractionSchema=JSON.parse(JSON.stringify(env.PRODUCT_ID?productCandidates:candidateSchema));
 extractionSchema.properties.candidates.items.properties.country={type:'string',enum:[campaign.country]};
 extractionSchema.properties.candidates.items.properties.evidenceExcerpt={type:'string',description:'An exact continuous substring of the supplied report, copied without paraphrasing, preferably 20-200 characters',minLength:20,maxLength:500};
 const extracted=await openai(env,s,JSON.stringify({report:outputText(report),sources,campaign}),`${researchSecurity} ${env.PRODUCT_ID?productQualificationPolicy:''} Extract only supported businesses from the report. Return an empty candidates array for insufficient evidence. Include exact excerpts supporting identity and target fit, the official website, and an exact consulted sourceUrl. country must be the ISO code ${campaign.country}; exclude businesses outside this country instead of relabeling them. ${env.PRODUCT_ID?'Set targetMatch using the approved product profile and ALL configured customer types, descriptions, targeting comments and offer preferences. Label contactScope as organization, public_professional or private_consumer. sensitivePersonalTarget must be true if the match depends on individual health, addiction, financial vulnerability or other sensitive personal trait; exclude such prospects and all private consumers. Individuals must be acting in a public professional capacity, with their professional name in contact_name and their public portfolio/site in website. Do not infer private interests or conditions. Explain fitEvidence for this exact product.':''} Never fill missing facts from memory.`,batch.id+':extract',{schema:extractionSchema,workflow:w,stage:'discover_extract',maxOutput:3500});
 let parsed=JSON.parse(outputText(extracted));if(!Array.isArray(parsed.candidates))throw new Error('Invalid discovery schema');
 if(parsed.candidates.length&&!parsed.candidates.some((c:any)=>listedSource(c.sourceUrl,sources)&&containsExcerpt(outputText(report),c.evidenceExcerpt)&&c.country===campaign.country)){
  const repair=await openai(env,s,JSON.stringify({report:outputText(report),sources,campaign,previousExtraction:parsed}),`${researchSecurity} Repair ONLY the candidate evidence extraction using the SAVED report. No new search and no new business facts. For evidenceExcerpt copy a short continuous substring (20-200 characters) EXACTLY from the supplied report, preserving words, punctuation and spelling. Do not paraphrase or merge separate sentences. Use the ISO country code ${campaign.country}. Choose only consulted source URLs supporting that business. Exclude a candidate if you cannot locate a literal supporting excerpt. Retain the approved product matching criteria and owner remarks.`,batch.id+':evidence-repair',{schema:extractionSchema,workflow:w,stage:'discover_evidence_repair',maxOutput:3500});
  parsed=JSON.parse(outputText(repair));
 }
 const prior=new Set((await all<any>(env,'SELECT entity_key FROM discovery_candidates WHERE batch_id=?',batch.id)).map(x=>x.entity_key));
 let processed=0,remaining=false;
 for(const c of parsed.candidates.slice(0,maximumCandidates)){
  const key=entityKey(String(c.company||''),String(c.website||''),String(c.city||''));
  if(prior.has(key))continue;
  if(processed>=3){remaining=true;break;}processed++;
  const fit=(env.PRODUCT_ID?c.targetMatch===true&&c.sensitivePersonalTarget===false&&['organization','public_professional'].includes(c.contactScope):c.independence==='independent'&&c.size==='small_or_midsize')&&String(c.fitEvidence||'').length>=20&&String(c.evidenceExcerpt||'').length>=20;
  const supported=!!publicUrl(c.website)&&listedSource(c.sourceUrl,sources)&&containsExcerpt(outputText(report),c.evidenceExcerpt)&&String(c.country||'').toUpperCase()===campaign.country&&!!String(c.company||'').trim()&&!!String(c.city||'').trim();
  let outcome='needs_review',leadId:string|null=null;
  if(fit&&supported){leadId=await importLead(env,{...c,source_url:c.sourceUrl,email:null},campaign);outcome=leadId?'imported':'duplicate';}
  await run(env,'INSERT OR IGNORE INTO discovery_candidates(id,batch_id,entity_key,data,outcome,lead_id,created_at) VALUES(?,?,?,?,?,?,?)',uid(),batch.id,key,JSON.stringify(c),outcome,leadId,now());
  prior.add(key);
 }
 if(remaining)throw new StageYield('Remaining discovery candidates queued for the next cycle');
 const counts=await one<any>(env,"SELECT COUNT(*) n,SUM(outcome='imported') imported,SUM(outcome='duplicate') duplicates,SUM(outcome='needs_review') held FROM discovery_candidates WHERE batch_id=?",batch.id);
 await run(env,'UPDATE discovery_batches SET state=?,candidates=?,imported=?,duplicates=?,held=?,updated_at=? WHERE id=?',counts.n?'complete':'no_results',counts.n,counts.imported||0,counts.duplicates||0,counts.held||0,now(),batch.id);
 await audit(env,'discovery_completed',batch.id,`${counts.imported||0} new independent businesses; ${counts.duplicates||0} duplicates; ${counts.held||0} need evidence review`);
 return {state:counts.n?'complete':'no_results',runId:batch.id};
}
