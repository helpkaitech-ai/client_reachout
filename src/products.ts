import type {Env,Product,Settings,Job} from './types';
import {defaults} from './types';
import {all,one,run,settings,now,uid,enqueue,audit,BudgetPaused} from './db';
import {productDatabase} from './product-store';
import {cleanEmail,publicUrl,validTimezone} from './policy';
import {openai,outputText,UncertainProviderError} from './providers';
import {StageYield} from './ai';
import {objectSchema,textField as str,researchSecurity,collectSources,listedSource} from './evidence';

export async function product(env:Env,id:string){const p=await one<Product>(env,'SELECT * FROM products WHERE id=?',id);if(!p)throw new Error('Product not found');return p;}
export async function productList(env:Env){return all<Product>(env,"SELECT * FROM products WHERE state<>'archived' ORDER BY created_at,id");}
export async function scopeProduct(root:Env,p:Product):Promise<Env>{
 const db=productDatabase(root,p.id),approved=p.state==='approved'&&p.approved_revision===p.revision&&p.enabled===1;
 const brief=JSON.stringify({name:p.name,website:p.website,description:p.description,remarks:p.remarks,approvedCustomerProfile:JSON.parse(p.analysis||'{}')});
 const env={...root,DB:db,GLOBAL_DB:root.GLOBAL_DB||root.DB,PRODUCT_ID:p.id,PRODUCT_NAME:p.name,PRODUCT_BRIEF:brief,PRODUCT_APPROVED:approved,PRODUCT_REVISION:p.revision,SENDER_EMAIL:p.sender_email,WORKSPACE_BACKUP:undefined};
 const base=await settings(root);
 env.DISCOVERY_PAUSED_UNTIL=base.discoveryPausedUntil;
 await run(env,'INSERT OR IGNORE INTO settings(id,data) VALUES(1,?)',JSON.stringify({...defaults,senderName:base.senderName,businessAddress:base.businessAddress,providerPolicyConfirmed:base.providerPolicyConfirmed,sendStartHour:base.sendStartHour,sendEndHour:base.sendEndHour,sendWeekends:base.sendWeekends,researchAutomation:false,campaigns:[],offerContext:brief}));
 await run(env,"INSERT OR IGNORE INTO integration_state(key,value) VALUES('inbox_cursor',?)",JSON.stringify({after:Math.floor(Date.parse(p.created_at)/1000)-120,before:0,page:''}));
 return env;
}
export function requireProductReady(env:Env){if(env.PRODUCT_ID&&!env.PRODUCT_APPROVED)throw new Error('Approve the current OpenAI target profile and enable this product before searching, generating drafts or sending.');}
export async function assertProductCurrent(env:Env){
 if(!env.PRODUCT_ID)return;
 requireProductReady(env);
 const current=await one<Product>({...env,DB:env.GLOBAL_DB!},'SELECT * FROM products WHERE id=?',env.PRODUCT_ID);
 if(!current||current.state!=='approved'||!current.enabled||current.revision!==env.PRODUCT_REVISION||current.approved_revision!==current.revision)throw new Error('Product details or approval changed. Reload the current product workspace.');
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
 const name=String(input.name||'').trim(),website=publicUrl(input.website),description=String(input.description||'').trim(),remarks=String(input.remarks||'').trim(),sender=cleanEmail(input.sender_email||env.SENDER_EMAIL);
 if(!name||name.length>120||!website||!description||description.length>12000||remarks.length>12000||!sender)throw new Error('Provide a name, public website, description, remarks under 12,000 characters and valid sender email');
 const images=input.images===undefined?null:validateAssets(input.images),old=id?await product(env,id):null,at=now(),key=id||uid();
 if(old){
  const revision=Number(input.revision);if(revision!==old.revision)throw new Error('Product changed in another window. Reload before saving');
  const changed=await run(env,"UPDATE products SET name=?,website=?,description=?,remarks=?,sender_email=?,revision=revision+1,state='draft',analysis='{}',approved_revision=NULL,error=NULL,updated_at=? WHERE id=? AND revision=?",name,website,description,remarks,sender,at,key,revision);
  if(!changed.meta.changes)throw new Error('Product changed; reload before saving');
 }else await run(env,'INSERT INTO products(id,name,website,description,remarks,sender_email,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',key,name,website,description,remarks,sender,at,at);
 const p=await product(env,key),scoped=await scopeProduct(env,p);
 const ops=[scoped.DB.prepare("UPDATE jobs SET state='cancelled',updated_at=? WHERE state IN ('pending','running','paused','paused_provider')").bind(at),scoped.DB.prepare("UPDATE drafts SET status='pending',quality_hold='Product details changed; approve the new target profile and review or improve this draft',approved_hash=NULL,approved_version=NULL,approved_at=NULL,updated_at=? WHERE status IN ('pending','approved')").bind(at)];
 if(images){ops.push(scoped.DB.prepare('DELETE FROM product_assets'));for(const image of images)ops.push(scoped.DB.prepare('INSERT INTO product_assets VALUES(?,?,?)').bind(image.id,image.name,image.data));}
 await scoped.DB.batch(ops);await audit(env,'product_saved',key,'Product revision saved; target approval required');return p;
}
export async function productDetail(env:Env,id:string){const p=await product(env,id),scope=await scopeProduct(env,p);return {product:p,images:await all(scope,'SELECT * FROM product_assets ORDER BY id'),analysis:JSON.parse(p.analysis||'{}'),usage:await one(scope,'SELECT * FROM daily_usage WHERE day=?',now().slice(0,10)),budget:await one(scope,"SELECT COALESCE(SUM(CASE WHEN state='settled' THEN actual ELSE reserved END),0) committed FROM expenses WHERE provider='openai' AND month=?",now().slice(0,7)),searchDiagnostics:await searchDiagnostics(scope)};}
async function searchDiagnostics(env:Env){
 const batches=await all<any>(env,'SELECT * FROM discovery_batches ORDER BY created_at DESC LIMIT 3'),result=[];
 for(const batch of batches){
  const response=await one<any>(env,"SELECT output FROM ai_attempts WHERE job_id=? AND stage='discover_search' AND state='complete' ORDER BY created_at DESC LIMIT 1",batch.job_id);if(!response)continue;
  const saved=JSON.parse(response.output),text=outputText(saved),sources=collectSources(saved),campaign=JSON.parse(batch.campaign);
  for(const row of await all<any>(env,"SELECT id,data FROM discovery_candidates WHERE batch_id=? AND outcome='needs_review'",batch.id)){
   const c=JSON.parse(row.data);
   // Return validation metadata only, never the cached provider response.
   result.push({candidateId:row.id,targetFit:c.targetMatch===true,websiteValid:!!publicUrl(c.website),sourceListed:listedSource(c.sourceUrl,sources),excerptFound:text.includes(c.evidenceExcerpt),countryMatches:String(c.country).toUpperCase()===campaign.country,hasIdentity:!!c.company&&!!c.city});
  }
 }
 return result;
}
export async function queueProductAnalysis(env:Env,id:string,confirmRetry=false){
 const p=await product(env,id),scope=await scopeProduct(env,p),jobId=`product-profile:${p.id}:${p.revision}`;
 const prior=await one<any>(scope,'SELECT * FROM jobs WHERE id=?',jobId);
 if(prior?.state==='uncertain')throw new Error('The previous request has an unknown outcome. Reconcile its provider charge before retrying');
 if(prior?.state==='complete')return {message:'Current analysis is ready for target-profile approval'};
 if(prior&&['failed','paused_provider'].includes(prior.state)){
  if(!confirmRetry)throw new Error('Confirm the new paid extraction attempt before retrying');
  const payload=JSON.parse(prior.payload);payload.retryVersion=(payload.retryVersion||0)+1;await run(scope,"UPDATE jobs SET state='pending',error=NULL,payload=?,updated_at=? WHERE id=?",JSON.stringify(payload),now(),jobId);
 }else await enqueue(scope,'product_analysis',null,{revision:p.revision},jobId);
 await run(env,"UPDATE products SET state='analyzing',error=NULL,updated_at=? WHERE id=? AND revision=?",now(),id,p.revision);
 return {message:'OpenAI product research queued. You will review the target profile before searches begin.'};
}
const campaignSchema=objectSchema({query:str,location:str,country:str,timezone:str,enabled:{type:'boolean'}});
const profileSchema=objectSchema({productSummary:str,valueProposition:str,targetCustomers:{type:'array',items:str},buyingRoles:{type:'array',items:str},targetingRationale:str,qualificationCriteria:{type:'array',items:str},exclusions:{type:'array',items:str},remarksApplied:{type:'array',items:str},emailGuidance:str,unknowns:{type:'array',items:str},sources:{type:'array',items:objectSchema({url:str,observation:str})},campaigns:{type:'array',minItems:1,maxItems:6,items:campaignSchema}});
export async function advanceProductAnalysis(root:Env,p:Product){
 const env=await scopeProduct(root,p),jobId=`product-profile:${p.id}:${p.revision}`,job=await one<any>(env,'SELECT * FROM jobs WHERE id=?',jobId);if(!job)return;
 if(job.state==='paused')await run(env,"UPDATE jobs SET state='pending' WHERE id=?",jobId);
 const claim=await run(env,"UPDATE jobs SET state='running',updated_at=? WHERE id=? AND (state='pending' OR (state='running' AND updated_at<?))",now(),jobId,new Date(Date.now()-15*60000).toISOString());if(!claim.meta.changes)return;
 const w={jobId,paidCalls:0,retryVersion:JSON.parse(job.payload).retryVersion||0};
 try{
  const s=await settings(env),assets=await all<any>(env,'SELECT data FROM product_assets ORDER BY id');
  const report=await openai(env,s,JSON.stringify({website:p.website,description:p.description,remarks:p.remarks}),`${researchSecurity} Research this PRODUCT and its official website, services, capabilities, pricing where public, documented use cases and intended buyers. Consider supplied owner remarks as targeting guidance, never as proof of a feature or customer result. Establish observed facts versus uncertainty. Find relevant product pages and corroboration. Do not use a fixed industry, company size, geography or solution template. Target customers must follow from this actual product. Do not discover prospect businesses yet.`,jobId,{search:true,workflow:w,stage:'product_search',maxOutput:3000,maxTools:4});
  const result=await openai(env,s,JSON.stringify({product:p,report:outputText(report),sources:collectSources(report)}),`${researchSecurity} Understand the supplied product and screenshots and propose a target-customer profile FOR OWNER APPROVAL. Derive buyer types, buying roles, inclusion/exclusion criteria, geographic search campaigns and email guidance from the product, web research and owner remarks. No standard industry or SMB restriction. Screenshots show interface/features, not proof of customer outcomes. Preserve every relevant remark in remarksApplied and in targeting/email guidance. Separate unknowns. Campaigns must use ISO two-letter countries, a specific city/country location and real IANA timezone; provide up to six diversified, evidence-led search scopes. Source URLs must be in the supplied research. Never invent capabilities, deployments, customers or results.`,jobId+':extract',{schema:profileSchema,workflow:w,stage:'product_extract',images:assets.map(a=>a.data),maxOutput:4500});
  const analysis=JSON.parse(outputText(result));
  if(!analysis.productSummary||!analysis.targetingRationale||!Array.isArray(analysis.campaigns)||!analysis.campaigns.length||analysis.campaigns.some((c:any)=>!c.query?.trim()||!c.location?.trim()||!/^[A-Z]{2}$/.test(c.country)||!validTimezone(c.timezone)))throw new Error('OpenAI target profile has incomplete or invalid search scopes; review product remarks and retry extraction');
  const listed=new Set(collectSources(report).map(s=>s.url));analysis.sources=analysis.sources.filter((s:any)=>listed.has(s.url));
  await run(root,"UPDATE products SET analysis=?,state='target_review',error=NULL,updated_at=? WHERE id=? AND revision=? AND state='analyzing'",JSON.stringify(analysis),now(),p.id,p.revision);
  await run(env,"UPDATE jobs SET state='complete',error=NULL,updated_at=? WHERE id=?",now(),jobId);
 }catch(e){
  const error=e instanceof Error?e.message:'Product research failed';
  if(e instanceof StageYield){await run(env,"UPDATE jobs SET state='pending',updated_at=? WHERE id=?",now(),jobId);return;}
  const state=e instanceof BudgetPaused?'paused':e instanceof UncertainProviderError?'uncertain':'failed';
  await run(env,'UPDATE jobs SET state=?,error=?,updated_at=? WHERE id=?',state,error,now(),jobId);
  await run(root,"UPDATE products SET state=?,error=?,updated_at=? WHERE id=? AND revision=?",state==='paused'?'analyzing':state,error,now(),p.id,p.revision);
 }
}
export async function approveProduct(env:Env,id:string,revision:number){
 const p=await product(env,id);if(p.revision!==revision||p.state!=='target_review')throw new Error('Review the current OpenAI target profile before approval');
 const analysis=JSON.parse(p.analysis),scope=await scopeProduct(env,p),s=await settings(scope);
 await run(scope,'UPDATE settings SET data=? WHERE id=1',JSON.stringify({...s,campaigns:analysis.campaigns,researchAutomation:true,offerContext:scope.PRODUCT_BRIEF}));
 const changed=await run(env,"UPDATE products SET state='approved',approved_revision=revision,error=NULL,updated_at=? WHERE id=? AND revision=? AND state='target_review'",now(),id,revision);if(!changed.meta.changes)throw new Error('Product changed before approval');
 await audit(env,'product_target_approved',id,'Owner approved the current OpenAI target profile; no email approved');return {ok:true};
}
