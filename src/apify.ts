import type {Env,Settings,Campaign} from './types';
import {one,run,now,reserve,settle,uncertainExpense,audit} from './db';
import {StageYield,type Workflow} from './ai';
import {UncertainProviderError,openai,outputText} from './providers';
import {objectSchema,textField,researchSecurity} from './evidence';
import {publicUrl} from './policy';
import type {SourcePage} from './source-pages';

export const linkedinActor='harvestapi~linkedin-profile-search';
export const linkedinBuild='0.0.298';
type ActorState={state:'submitting'|'running'|'complete'|'failed';expenseId:string;runId?:string;datasetId?:string;startedAt:string;pages?:SourcePage[];error?:string};
const planSchema=objectSchema({searchQuery:textField,currentJobTitles:{type:'array',maxItems:4,items:textField}});

// Never include tokens in URLs, provider errors, saved inputs or browser responses.
export async function apifyRequest(env:Env,path:string,init:RequestInit={}){
 if(!env.APIFY_TOKEN)throw new Error('Add APIFY_TOKEN as a Cloudflare Worker secret before using LinkedIn discovery');
 const response=await fetch('https://api.apify.com/v2/'+path,{...init,redirect:'manual',signal:AbortSignal.timeout(25000),headers:{Authorization:`Bearer ${env.APIFY_TOKEN}`,'Content-Type':'application/json',...init.headers}});
 if(!response.ok){await response.body?.cancel();throw new Error(`Apify request failed (HTTP ${response.status}); check token, actor access and account credits`);}
 if(!response.body)throw new Error('Apify returned an empty response');
 const reader=response.body.getReader(),decoder=new TextDecoder();let text='',bytes=0;
 try{while(true){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>2*1024*1024){await reader.cancel();throw new Error('Apify response exceeded the bounded result size');}text+=decoder.decode(chunk.value,{stream:true});}text+=decoder.decode();}finally{reader.releaseLock();}
 return JSON.parse(text);
}
export function actorInput(plan:{searchQuery:string;currentJobTitles:string[]},campaign:Campaign,index:number,customerTypes:string[]=[]){
 const country=new Intl.DisplayNames(['en'],{type:'region'}).of(campaign.country)||campaign.country;
 const city=campaign.location.split(',')[0].trim();
 return {profileScraperMode:'Full',searchQuery:customerTypes.includes('startups')?'startup':String(plan.searchQuery||'').trim().split(/\s+/).slice(0,2).join(' ').slice(0,100),currentJobTitles:plan.currentJobTitles.slice(0,4).map(x=>x.slice(0,100)),locations:[city===country?country:`${city}, ${country}`],maxItems:25,startPage:1,takePages:1,autoQuerySegmentation:false};
}
// Retain only public professional context, not education, photos or personal data.
// Full mode does not perform third-party email enrichment. Published addresses
// still need an exact source and business-identity check in the normal pipeline.
export function profilePages(items:unknown[],runId:string):SourcePage[]{
 const pages:SourcePage[]=[];
 for(const item of items.slice(0,25)){
  if(!item||typeof item!=='object')continue;const p=item as Record<string,any>;
  const url=publicUrl(p.linkedinUrl||p.profileUrl||p.url);if(!url)continue;
  const parsed=new URL(url);if(!/(^|\.)linkedin\.com$/.test(parsed.hostname)||!parsed.pathname.startsWith('/in/'))continue;
  const plain=(value:unknown):string=>typeof value==='string'?value.slice(0,6000):'';
  const experience=Array.isArray(p.experience)?p.experience:Array.isArray(p.experiences)?p.experiences:[];
  const lines=[plain(p.firstName)+' '+plain(p.lastName),plain(p.headline),plain(p.about||p.summary),plain(p.location?.linkedinText||p.location?.name||p.location)];
  for(const e of experience.slice(0,5))if(e&&typeof e==='object')lines.push(...[e.position||e.title,e.companyName||e.company?.name,e.description,e.duration,e.startDate?.text,e.endDate?.text,e.companyLinkedinUrl||e.company?.linkedinUrl].map(plain));
  const text=lines.filter(x=>x.trim()).join('\n').slice(0,16000);if(text.length<60)continue;
  pages.push({url,finalUrl:url,text,fetchedAt:now(),provider:'apify',providerRunId:runId});
 }
 return [...new Map(pages.map(p=>[p.url,p])).values()];
}
export async function linkedinDiscovery(env:Env,s:Settings,jobId:string,campaign:Campaign,w:Workflow,index=0):Promise<SourcePage[]>{
 if(s.discoveryProvider!=='hybrid')return [];
 if(!env.APIFY_TOKEN)throw new Error('LinkedIn discovery requires APIFY_TOKEN in Cloudflare Worker secrets');
 const key=jobId+':apify',saved=await one<{data:string}>(env,'SELECT data FROM pipeline_results WHERE job_id=?',key);
 let state:ActorState|undefined=saved?JSON.parse(saved.data):undefined;
 const save=async()=>run(env,'INSERT OR REPLACE INTO pipeline_results(job_id,data,created_at) VALUES(?,?,?)',key,JSON.stringify(state),now());
 if(state?.state==='complete')return state.pages||[];
 if(state?.state==='failed')throw new Error(state.error||'Apify run failed; inspect the saved run before another search');
 if(state?.state==='submitting')throw new UncertainProviderError('Apify');
 if(!state){
  const result=await openai(env,s,JSON.stringify({location:campaign.location,country:campaign.country,searchAngle:campaign.query,index}),`${researchSecurity} Plan ONE bounded LinkedIn people search using the owner product profile and workspace targeting. Choose 1-4 related current professional job titles and optionally ONE business-context word as searchQuery. Never include activities, deliverables or pain keywords in searchQuery. Rotate departments across searchIndex; include actual users as well as buyers. Never require founder/owner status, small company size, technology industry, a repeated reporting cadence, spreadsheet pain or exact file format unless the owner explicitly requires it. Prefer a broad role filter and a simple business context keyword; do not AND-stack constraints. Empty searchQuery is valid when titles suffice. Do not invent a company list or location. Return only the search input.`,jobId+':linkedin-plan',{schema:planSchema,workflow:w,stage:'linkedin_plan',maxOutput:1000});
  const input=actorInput(JSON.parse(outputText(result)),campaign,index,s.customerTypes);
  const expenseId=await reserve(env,'apify',s.apifyRunCap,s.apifyBudget,jobId+':linkedin');
  state={state:'submitting',expenseId,startedAt:now()};
  const claimed=await run(env,'INSERT OR IGNORE INTO pipeline_results(job_id,data,created_at) VALUES(?,?,?)',key,JSON.stringify(state),now());
  if(!claimed.meta.changes){await settle(env,expenseId,0,'Another invocation owns this actor submission');throw new StageYield('LinkedIn run already submitted');}
  try{
   const result=await apifyRequest(env,`acts/${linkedinActor}/runs?build=${linkedinBuild}&timeout=300&memory=256&maxTotalChargeUsd=${s.apifyRunCap}`,{method:'POST',body:JSON.stringify(input)});
   if(!/^[a-zA-Z0-9]+$/.test(result.data?.id||''))throw new Error('Apify did not return a run identifier');
   state={...state,state:'running',runId:result.data.id,datasetId:result.data.defaultDatasetId};await save();
   await audit(env,'linkedin_search_started',jobId,JSON.stringify({actor:linkedinActor,build:linkedinBuild,runId:state.runId,input,chargeCap:s.apifyRunCap}));
  }catch{await uncertainExpense(env,expenseId);throw new UncertainProviderError('Apify');}
  throw new StageYield('LinkedIn search is running in the background');
 }
 const result=await apifyRequest(env,`actor-runs/${state.runId}`),info=result.data;
 if(!info||info.id!==state.runId)throw new Error('Apify run response does not match the saved search');
 if(['READY','RUNNING','TIMING-OUT','ABORTING'].includes(info.status))throw new StageYield('LinkedIn search still running');
 if(typeof info.usageTotalUsd==='number')await settle(env,state.expenseId,info.usageTotalUsd,'Apify reported actor run usage');
 if(info.status!=='SUCCEEDED'){
  state={...state,state:'failed',error:`LinkedIn actor ${info.status}; saved run ${state.runId}. Check Apify credits and run log.`};await save();throw new Error(state.error);
 }
 const dataset=info.defaultDatasetId||state.datasetId;
 if(!/^[a-zA-Z0-9]+$/.test(dataset||''))throw new Error('Apify run has no valid result dataset');
 const items=await apifyRequest(env,`datasets/${dataset}/items?clean=true&limit=25&fields=linkedinUrl,firstName,lastName,headline,about,location,experience`);
 if(!Array.isArray(items))throw new Error('Apify dataset format is invalid');
 state={...state,state:'complete',datasetId:dataset,pages:profilePages(items,state.runId!)};await save();
 await audit(env,'linkedin_search_completed',jobId,`${state.pages!.length} public professional profiles from Apify run ${state.runId}`);
 return state.pages!;
}
