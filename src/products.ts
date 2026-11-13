import {assertJobActive,WorkCancelled} from './job-control';
import type {Env,Product,Settings,Job} from './types';
import {searchTarget} from './discovery-cycles';
import {defaults} from './types';
import {all,one,run,settings,now,day,uid,enqueue,audit,BudgetPaused} from './db';
import {productDatabase} from './product-store';
import {cleanEmail,publicUrl,validTimezone,validateSettings} from './policy';
import {openai,outputText,UncertainProviderError} from './providers';
import {StageYield} from './ai';
import {objectSchema,textField as str,researchSecurity,collectSources,listedSource,productQualificationPolicy} from './evidence';
import {useCaseSchema,validUseCases,supportedCapability,productFitInstructions} from './product-fit';
import {providerBlock,OpenAICreditBlocked,assertProviderAvailable} from './provider-control';

export async function product(env:Env,id:string){const p=await one<Product>(env,'SELECT * FROM products WHERE id=?',id);if(!p)throw new Error('Product not found');return p;}
export async function productList(env:Env){
 const products=await all<Product>(env,"SELECT * FROM products WHERE state<>'archived' ORDER BY created_at,id");
 return products;
}
export async function scopeProduct(root:Env,p:Product):Promise<Env>{
 const db=productDatabase(root,p.id),approved=p.state==='approved'&&p.approved_revision===p.revision;
 const brief=JSON.stringify({name:p.name,website:p.website,description:p.description,remarks:p.remarks,approvedCustomerProfile:JSON.parse(p.analysis||'{}')});
 const env={...root,DB:db,GLOBAL_DB:root.GLOBAL_DB||root.DB,PRODUCT_ID:p.id,PRODUCT_NAME:p.name,PRODUCT_BRIEF:brief,PRODUCT_APPROVED:approved,PRODUCT_REVISION:p.revision,SENDER_EMAIL:p.sender_email,WORKSPACE_BACKUP:undefined};
 const base=await settings(root);
 await run(env,'INSERT OR IGNORE INTO settings(id,data) VALUES(1,?)',JSON.stringify({...defaults,senderName:base.senderName,businessAddress:base.businessAddress,providerPolicyConfirmed:base.providerPolicyConfirmed,sendStartHour:base.sendStartHour,sendEndHour:base.sendEndHour,sendWeekends:base.sendWeekends,campaigns:[],offerContext:p.description}));
 const local=await settings(env);
 // Older releases stored an internal product brief in the editable offer field.
 // Convert only that recognized generated shape; preserve owner-authored offers.
 let generated:any;try{generated=JSON.parse(local.offerContext);}catch{}
 if(generated&&typeof generated.description==='string'&&'approvedCustomerProfile' in generated)await run(env,"UPDATE settings SET data=json_set(data,'$.offerContext',?) WHERE id=1",generated.description);
 await run(env,"INSERT OR IGNORE INTO integration_state(key,value) VALUES('inbox_cursor',?)",JSON.stringify({after:Math.floor(Date.parse(p.created_at)/1000)-120,before:0,page:''}));
 return env;
}
export function requireProductReady(env:Env){if(env.PRODUCT_ID&&!env.PRODUCT_APPROVED)throw new Error('The product profile is not ready. Find prospects generates and applies it automatically before searching.');}
export async function assertProductCurrent(env:Env){
 if(!env.PRODUCT_ID)return;
 requireProductReady(env);
 const current=await one<Product>({...env,DB:env.GLOBAL_DB!},'SELECT * FROM products WHERE id=?',env.PRODUCT_ID);
 if(!current||current.state!=='approved'||current.revision!==env.PRODUCT_REVISION||current.approved_revision!==current.revision||current.sender_email!==env.SENDER_EMAIL)throw new Error('Product details, sender or approval changed. Reload the current product workspace.');
}
function validateAssets(images:any){
 if(!Array.isArray(images)||images.length>3)throw new Error('Upload up to three screenshots');
 return images.map((image:any)=>{
  const m=String(image.data||'').match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/);if(!m)throw new Error('Screenshots must be PNG, JPEG or WebP images');
  const bytes=Buffer.from(m[2],'base64');if(!bytes.length||bytes.length>512000)throw new Error('Each screenshot must be at most 500 KB');
  const valid=m[1]==='png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):m[1]==='jpeg'?bytes[0]===255&&bytes[1]===216&&bytes[2]===255:bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';
  if(!valid)throw new Error('Screenshot contents do not match the image type');
  return {id:uid(),name:String(image.name||'Screenshot').slice(0,120),data:String(image.data)};
 });
}
export async function saveProduct(env:Env,input:any,id?:string){
 const customerInput=Object.fromEntries(['customerTypes','customerDescription','customerComments'].filter(k=>input[k]!==undefined).map(k=>[k,input[k]]));
 validateSettings({...defaults,...customerInput});
 const name=String(input.name||'').trim(),website=publicUrl(input.website),description=String(input.description||'').trim(),remarks=String(input.remarks||'').trim(),sender=cleanEmail(input.sender_email||env.SENDER_EMAIL);
 if(!name||name.length>120||!website||!description||description.length>12000||remarks.length>12000||!sender)throw new Error('Provide a name, public website, description, remarks under 12,000 characters and valid sender email');
 const images=input.images===undefined?null:validateAssets(input.images),old=id?await product(env,id):null,at=now(),key=id||uid();
 if(old){
  const revision=Number(input.revision);if(revision!==old.revision)throw new Error('Product changed in another window. Reload before saving');
  const changed=await run(env,"UPDATE products SET name=?,website=?,description=?,remarks=?,sender_email=?,revision=revision+1,state='draft',analysis='{}',approved_revision=NULL,error=NULL,updated_at=? WHERE id=? AND revision=?",name,website,description,remarks,sender,at,key,revision);
  if(!changed.meta.changes)throw new Error('Product changed; reload before saving');
 }else await run(env,'INSERT INTO products(id,name,website,description,remarks,sender_email,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',key,name,website,description,remarks,sender,at,at);
 const p=await product(env,key),scoped=await scopeProduct(env,p),local=await settings(scoped);
 const preferences={...local,...customerInput,offerContext:!old||local.offerContext===old.description?description:local.offerContext};
 const ops=[scoped.DB.prepare('UPDATE settings SET data=? WHERE id=1').bind(JSON.stringify(preferences)),scoped.DB.prepare("UPDATE jobs SET state='cancelled',updated_at=? WHERE state IN ('pending','running','paused','paused_provider')").bind(at),scoped.DB.prepare("UPDATE drafts SET status='pending',quality_hold='Product details changed; review or improve this draft against the refreshed profile',approved_hash=NULL,approved_version=NULL,approved_at=NULL,updated_at=? WHERE status IN ('pending','approved')").bind(at)];
 ops.push(scoped.DB.prepare("DELETE FROM integration_state WHERE key='manual_search_request'"));
 if(images){ops.push(scoped.DB.prepare('DELETE FROM product_assets'));for(const image of images)ops.push(scoped.DB.prepare('INSERT INTO product_assets VALUES(?,?,?)').bind(image.id,image.name,image.data));}
 await scoped.DB.batch(ops);await audit(env,'product_saved',key,'Product revision saved; the next search generates and applies its profile automatically');return p;
}
export async function productDetail(env:Env,id:string){const p=await product(env,id),scope=await scopeProduct(env,p),s=await settings(scope);return {product:{...p,customerTypes:s.customerTypes,customerDescription:s.customerDescription,customerComments:s.customerComments},settings:s,providerBlock:await providerBlock(scope),images:await all(scope,'SELECT * FROM product_assets ORDER BY id'),analysis:JSON.parse(p.analysis||'{}'),usage:await one(scope,'SELECT * FROM daily_usage WHERE day=?',now().slice(0,10)),budget:await one(scope,"SELECT COALESCE(SUM(CASE WHEN state='settled' THEN actual ELSE reserved END),0) committed FROM expenses WHERE provider='openai' AND month=?",now().slice(0,7)),searchDiagnostics:await searchDiagnostics(scope)};}
export async function requestProductDiscovery(env:Env,target=12){
 searchTarget(target);
 if(!env.OPENAI_API_KEY)throw new Error('Configure OpenAI before finding prospects');
 const root={...env,DB:env.GLOBAL_DB!},p=await product(root,env.PRODUCT_ID!);
 await assertProviderAvailable(env);
 if(p.state==='archived')throw new Error('This product is archived');
 if(!p.enabled)await run(root,'UPDATE products SET enabled=1 WHERE id=?',p.id);
 const scope=await scopeProduct(root,p);
 await run(scope,"INSERT INTO integration_state(key,value) VALUES('manual_search_request',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",JSON.stringify({id:uid(),revision:p.revision,target}));
 if(p.state==='target_review'){await approveProduct(root,p.id,p.revision);return continueProductDiscovery(root,await product(root,p.id));}
 if(p.state==='approved'&&p.approved_revision===p.revision)return continueProductDiscovery(root,p);
 await queueProductAnalysis(root,p.id);
 return {state:'profiling',message:'Preparing product profile. Search will start automatically.'};
}
export async function continueProductDiscovery(root:Env,p:Product){
 const scope=await scopeProduct(root,p),row=await one<{value:string}>(scope,"SELECT value FROM integration_state WHERE key='manual_search_request'");
 if(!row)return;
 const request=JSON.parse(row.value);
 if(request.revision!==p.revision){
  await run(scope,"DELETE FROM integration_state WHERE key='manual_search_request'");return;
 }
 const {startDiscovery}=await import('./discovery');
 const result=await startDiscovery(scope,await settings(scope),undefined,undefined,true,false,request.target||12,request.id||'legacy:'+request.revision);
 if(['queued','running','researching'].includes(result.state))await run(scope,"DELETE FROM integration_state WHERE key='manual_search_request' AND value=?",row.value);
 return result;
}
async function searchDiagnostics(env:Env){
 const batches=await all<any>(env,'SELECT * FROM discovery_batches ORDER BY created_at DESC LIMIT 3'),result=[];
 for(const batch of batches){
  const response=await one<any>(env,"SELECT output FROM ai_attempts WHERE job_id=? AND stage='discover_search' AND state='complete' ORDER BY created_at DESC LIMIT 1",batch.job_id);if(!response)continue;
  const saved=JSON.parse(response.output),text=outputText(saved),sources=collectSources(saved),campaign=JSON.parse(batch.campaign);
  for(const row of await all<any>(env,"SELECT id,data FROM discovery_candidates WHERE batch_id=? AND outcome NOT IN ('imported','duplicate')",batch.id)){
   const c=JSON.parse(row.data);
   // Return validation metadata only, never the cached provider response.
   result.push({candidateId:row.id,rejectionReasons:c.discoveryIssues||[],contactSourced:c.publicContact?.evidenceType==='opened_page',targetFit:c.targetMatch===true,websiteValid:!!publicUrl(c.website),sourceListed:listedSource(c.sourceUrl,sources),excerptFound:text.includes(c.evidenceExcerpt),countryMatches:String(c.country).toUpperCase()===campaign.country,hasIdentity:!!c.company&&!!c.city});
  }
 }
 return result;
}
export async function queueProductAnalysis(env:Env,id:string,confirmRetry=false){
 await assertProviderAvailable(env);
 const p=await product(env,id),scope=await scopeProduct(env,p),jobId=`product-profile:${p.id}:${p.revision}`;
 const prior=await one<any>(scope,'SELECT * FROM jobs WHERE id=?',jobId);
 if(prior?.state==='uncertain')throw new Error('The previous request has an unknown outcome. Reconcile its provider charge before retrying');
 if(prior?.state==='complete')return {message:'Current product profile is ready'};
 if(prior?.state==='cancelled'){await run(scope,"UPDATE jobs SET state='pending',error=NULL,updated_at=? WHERE id=?",now(),jobId);}
 else if(prior&&['failed','paused_provider'].includes(prior.state)){
  if(!confirmRetry)throw new Error('Confirm the new paid extraction attempt before retrying');
  const payload=JSON.parse(prior.payload);payload.retryVersion=(payload.retryVersion||0)+1;await run(scope,"UPDATE jobs SET state='pending',error=NULL,payload=?,updated_at=? WHERE id=?",JSON.stringify(payload),now(),jobId);
 }else await enqueue(scope,'product_analysis',null,{revision:p.revision},jobId);
 await run(env,"UPDATE products SET state='analyzing',error=NULL,updated_at=? WHERE id=? AND revision=?",now(),id,p.revision);
 return {message:'Product profile generation queued. It will be applied automatically.'};
}
const campaignSchema=objectSchema({query:str,location:str,country:str,timezone:str,enabled:{type:'boolean'}});
const profileSchema=objectSchema({useCases:{type:'array',minItems:1,maxItems:6,items:useCaseSchema},productSummary:str,valueProposition:str,targetCustomers:{type:'array',items:str},buyingRoles:{type:'array',items:str},targetingRationale:str,qualificationCriteria:{type:'array',items:str},exclusions:{type:'array',items:str},remarksApplied:{type:'array',items:str},emailGuidance:str,unknowns:{type:'array',items:str},sources:{type:'array',items:objectSchema({url:str,observation:str})},campaigns:{type:'array',minItems:1,maxItems:6,items:campaignSchema}});
export async function advanceProductAnalysis(root:Env,p:Product){
 const env=await scopeProduct(root,p),jobId=`product-profile:${p.id}:${p.revision}`,job=await one<any>(env,'SELECT * FROM jobs WHERE id=?',jobId);if(!job)return;
 if(job.state==='paused')await run(env,"UPDATE jobs SET state='pending' WHERE id=?",jobId);
 const claim=await run(env,"UPDATE jobs SET state='running',updated_at=? WHERE id=? AND (state='pending' OR (state='running' AND updated_at<?))",now(),jobId,new Date(Date.now()-15*60000).toISOString());if(!claim.meta.changes)return;
 const w={jobId,paidCalls:0,retryVersion:JSON.parse(job.payload).retryVersion||0};
 try{
  const s=await settings(env),assets=await all<any>(env,'SELECT data FROM product_assets ORDER BY id');
  const report=await openai(env,s,JSON.stringify({website:p.website,description:p.description,remarks:p.remarks}),`${researchSecurity} Research this PRODUCT using its official feature, documentation, pricing and limitation pages, supplied description and screenshots. Establish what it actually accepts as inputs, what it does, what outputs it produces, what it does NOT support and which professional workflows benefit. Separate current purchasable capabilities from roadmap, integrations and aspirational claims. Resolve differences between owner-supplied facts and website claims explicitly rather than silently inventing a feature. Identify specific buyer jobs and public evidence signals, not just broad industries. Consider supplied owner remarks as targeting guidance, never as proof of a feature or customer result. Establish observed facts versus uncertainty. Find relevant product pages and corroboration. Do not use a fixed industry, company size, geography or solution template. Target customers must follow from this actual product. Do not discover prospect businesses yet.`,jobId,{search:true,workflow:w,stage:'product_search',domains:[new URL(p.website).hostname],searchContext:'high',maxOutput:3000,maxTools:4});
  const result=await openai(env,s,JSON.stringify({product:p,report:outputText(report),sources:collectSources(report)}),`${researchSecurity} ${productQualificationPolicy} Understand the supplied product and screenshots and create a target-customer profile to apply automatically. Build 1-6 concrete useCases, each with a stable lowercase id, buyerRole, workflow, one actual productCapability, observable fitSignals, poorFitSignals and 2-4 searchPhrases (each at most 150 characters). capabilityEvidence must quote a short continuous exact excerpt without wrapping quotation marks from either the consulted product report (official_page with a listed sourceUrl), product.description (owner_description), or product.remarks (owner_remarks); do not invent evidence for capabilities. Map every use case to current supported features and the owner’s actual requirements; broad industries alone are not use cases. Search phrases must be location-neutral concise discovery queries of 3-6 words describing a buyer service or professional deliverable; geography belongs only in campaigns and is added at runtime. Do not combine contact/email, job title, file format and pain in one phrase. Discover the workflow first; verify contacts and internal compatibility separately. Do not search our product brand or hypothetical internal requirements. Use poorFitSignals for positive descriptions of observable exclusions and essential incompatibilities, not absence of evidence, unknown buying intent or internal file format. For example: requires a live API integration; never: no evidence of needing integrations. ${productFitInstructions} Derive buyer types, buying roles, inclusion/exclusion criteria, geographic search campaigns and email guidance from the product, web research and owner remarks. No standard industry or SMB restriction. Screenshots show interface/features, not proof of customer outcomes. Preserve every relevant remark and workspace customer type, description and targeting comment in remarksApplied and in targeting/email guidance. Honor selected locations, the configured offer and portfolio/pricing. B2C describes the product market; research public organizations or professional channels rather than private consumers profiled by sensitive conditions. Explain any targeting limitations in unknowns in the generated profile. Separate unknowns. Buying willingness, authority, budget and internal CSV/Excel file formats are unknown until evidenced; do not require public confirmation of them as mandatory qualification criteria unless the owner explicitly requires it. A public professional role with sourced responsibilities or relevant business activity can establish plausible fit. Do not narrow all use cases to recurring reporting: include data cleanup, exploration, answering business questions, charts and decisions when supported. Do not infer technical proficiency from industry or job title. Reject a product limitation only when an essential incompatible requirement is evidenced. When selected locations include worldwide, diversify campaigns across multiple countries; otherwise keep them within the selected geography and explicit owner constraints. Campaigns must use ISO two-letter countries, a specific city/country location and real IANA timezone; provide up to six diversified, evidence-led search scopes. Source URLs must be in the supplied research. Never invent capabilities, deployments, customers or results.`,jobId+':extract',{schema:profileSchema,workflow:w,stage:'product_extract',images:assets.map(a=>a.data),maxOutput:6000});
  let analysis=JSON.parse(outputText(result));
  const supported=(a:any)=>validUseCases(a.useCases)&&a.useCases.every((c:any)=>supportedCapability(c,p,outputText(report),collectSources(report)));
  if(!supported(analysis)){
   const repair=await openai(env,s,JSON.stringify({product:p,report:outputText(report),sources:collectSources(report),previousProfile:analysis}),`${researchSecurity} Repair this target profile using only the supplied product facts. Every capabilityEvidence excerpt must be a continuous EXACT quotation from product.description, product.remarks, or the consulted official product report, with correct sourceType. Never shorten by removing words inside a quotation or invent capabilities. Use poorFitSignals only for positive descriptions of evidenced incompatibilities, never absence of evidence. Preserve the owner targeting, broad supported use cases and valid campaigns. Return the complete corrected profile.`,jobId+':profile-evidence-repair',{schema:profileSchema,workflow:w,stage:'product_profile_evidence_repair',maxOutput:6000});
   analysis=JSON.parse(outputText(repair));
  }
  if(!validUseCases(analysis.useCases)||!analysis.useCases.every((c:any)=>supportedCapability(c,p,outputText(report),collectSources(report)))||!analysis.productSummary||!analysis.targetingRationale||!Array.isArray(analysis.campaigns)||!analysis.campaigns.length||analysis.campaigns.some((c:any)=>!c.query?.trim()||!c.location?.trim()||!/^[A-Z]{2}$/.test(c.country)||!validTimezone(c.timezone)))throw new Error('OpenAI profile lacks grounded use cases, capability evidence or valid search scopes; review product facts and retry extraction');
  const listed=new Set(collectSources(report).map(s=>s.url));analysis.sources=analysis.sources.filter((s:any)=>listed.has(s.url));
  await assertJobActive(env,w);
  const saved=await run(root,"UPDATE products SET analysis=?,state='target_review',error=NULL,updated_at=? WHERE id=? AND revision=? AND state='analyzing'",JSON.stringify(analysis),now(),p.id,p.revision);
  if(!saved.meta.changes)return;
  await approveProduct(root,p.id,p.revision);
  await run(env,"UPDATE jobs SET state='complete',error=NULL,updated_at=? WHERE id=?",now(),jobId);
 }catch(e){
  if(e instanceof WorkCancelled)return;
  const error=e instanceof Error?e.message:'Product research failed';
  if(e instanceof StageYield){await run(env,"UPDATE jobs SET state='pending',updated_at=? WHERE id=? AND state='running'",now(),jobId);return;}
  const state=e instanceof BudgetPaused?'paused':e instanceof OpenAICreditBlocked||/credit_balance_exhausted|insufficient_quota|billing_hard_limit_reached/.test(error)?'paused_provider':e instanceof UncertainProviderError?'uncertain':'failed';
  await run(env,'UPDATE jobs SET state=?,error=?,updated_at=? WHERE id=?',state,error,now(),jobId);
  await run(root,"UPDATE products SET state=?,error=?,updated_at=? WHERE id=? AND revision=?",state==='paused'?'analyzing':state,error,now(),p.id,p.revision);
 }
}
export async function approveProduct(env:Env,id:string,revision:number){
 const p=await product(env,id);if(p.revision===revision&&p.state==='approved'&&p.approved_revision===revision)return {ok:true};if(p.revision!==revision||p.state!=='target_review')throw new Error('Product profile is still being prepared');
 const analysis=JSON.parse(p.analysis),scope=await scopeProduct(env,p),s=await settings(scope);
 await run(scope,'UPDATE settings SET data=? WHERE id=1',JSON.stringify({...s,campaigns:analysis.campaigns}));
 const changed=await run(env,"UPDATE products SET state='approved',approved_revision=revision,error=NULL,updated_at=? WHERE id=? AND revision=? AND state='target_review'",now(),id,revision);if(!changed.meta.changes)throw new Error('Product changed. Search again.');
 await audit(env,'product_target_approved',id,'Generated product profile applied automatically; no email approved');return {ok:true};
}
