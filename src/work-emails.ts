import type {Env,Settings} from './types';
import type {Workflow} from './ai';
import {StageYield} from './ai';
import {one,run,reserve,settle,uncertainExpense,now,audit} from './db';
import {openai,outputText,UncertainProviderError} from './providers';
import {apifyRequest} from './apify';
import {collectSources,sourceKey,domainOf,objectSchema,textField,researchSecurity} from './evidence';
import {publicUrl,cleanEmail} from './policy';
import {workAddress,verifiedMailbox} from './work-email-policy';
import type {SourcePage} from './source-pages';

export const enrichmentActor='harvestapi~linkedin-profile-scraper',verifierActor='thirdwatch~email-verifier';
type Run={state:string;expenseId:string;runId?:string;items?:any[];completedAt?:string;error?:string};
// One durable submission per checkpoint. Read/poll failures never resubmit it.
export async function actorDataset(env:Env,s:Settings,key:string,actor:string,build:string,input:object,fields?:string,retain?:(items:any[])=>any[]){
 const row=await one<{data:string}>(env,'SELECT data FROM pipeline_results WHERE job_id=?',key);let saved:Run|undefined=row?JSON.parse(row.data):undefined;
 const save=()=>run(env,'INSERT OR REPLACE INTO pipeline_results VALUES(?,?,?)',key,JSON.stringify(saved),now());
 if(saved?.state==='complete')return saved;
 if(saved?.state==='failed')throw Error(saved.error);
 if(saved?.state==='submitting')throw new UncertainProviderError('Apify');
 if(!saved){
  const expenseId=await reserve(env,'apify',s.apifyRunCap,s.apifyBudget,key);saved={state:'submitting',expenseId};
  const claimed=await run(env,'INSERT OR IGNORE INTO pipeline_results VALUES(?,?,?)',key,JSON.stringify(saved),now());
  if(!claimed.meta.changes){await settle(env,expenseId,0);throw new StageYield('Actor checkpoint already owned');}
  try{const r=await apifyRequest(env,`acts/${actor}/runs?build=${build}&timeout=600&memory=256&maxTotalChargeUsd=${s.apifyRunCap}`,{method:'POST',body:JSON.stringify(input)});if(!/^[a-zA-Z0-9]+$/.test(r.data?.id||''))throw Error('Missing actor run ID');saved={...saved,state:'running',runId:r.data.id};await save();await audit(env,'work_email_actor_started',key,JSON.stringify({actor,runId:saved.runId}));}catch{await uncertainExpense(env,expenseId);throw new UncertainProviderError('Apify');}
  throw new StageYield('Work-email enrichment or verification is running');
 }
 const result=await apifyRequest(env,'actor-runs/'+saved.runId),r=result.data;
 if(r?.id!==saved.runId)throw Error('Actor run ID mismatch');
 if(['READY','RUNNING','TIMING-OUT','ABORTING'].includes(r.status))throw new StageYield('Work-email actor still running');
 if(typeof r.usageTotalUsd==='number')await settle(env,saved.expenseId,r.usageTotalUsd,'Apify reported actor usage');
 if(r.status!=='SUCCEEDED'){saved={...saved,state:'failed',error:`Work-email actor ${r.status}; inspect run ${saved.runId}`};await save();throw Error(saved.error);}
 if(!/^[a-zA-Z0-9]+$/.test(r.defaultDatasetId||''))throw Error('Invalid actor dataset');
 const items=await apifyRequest(env,`datasets/${r.defaultDatasetId}/items?clean=true&limit=10${fields?'&fields='+encodeURIComponent(fields):''}`);if(!Array.isArray(items))throw Error('Invalid actor dataset response');
 saved={...saved,state:'complete',items:(retain?retain(items):items).slice(0,10),completedAt:now()};await save();return saved;
}
export function professionalEmailRecords(items:any[],people:any[]){
 return items.flatMap(record=>{
  const person=people.find(p=>sourceKey(p.profileUrl)===sourceKey(record.linkedinUrl));if(!person)return [];
  const values=[record.email,record.workEmail,...(Array.isArray(record.emails)?record.emails:[]),...(Array.isArray(record.workEmails)?record.workEmails:[])];
  const emails=values.flatMap(value=>{const email=workAddress(typeof value==='string'?value:value?.email,person.website);return email?[typeof value==='string'?{email}:{email,...Object.fromEntries(['status','deliverable','catchAllDomain','validEmailServer','free','qualityScore'].filter(k=>value[k]!==undefined).map(k=>[k,value[k]]))}]:[];});
  return [{linkedinUrl:record.linkedinUrl,emails}];
 });
}
const shortlistSchema=objectSchema({people:{type:'array',maxItems:6,items:objectSchema({profileUrl:textField,company:textField,website:textField,contactName:textField})}});
export async function enrichWorkEmails(env:Env,s:Settings,jobId:string,w:Workflow,report:any,pages:SourcePage[]){
 if(!s.allowWorkEmailEnrichment||s.discoveryProvider!=='hybrid')return [];
 const known=new Set([...pages.map(p=>sourceKey(p.url)),...collectSources(report).map(p=>sourceKey(p.url))]);
 const planned=await openai(env,s,JSON.stringify({research:outputText(report),sources:collectSources(report),professionals:pages.map(p=>({url:p.url,text:p.text}))}),`${researchSecurity} Select up to six strongest relevant professionals meeting the owner targeting at their current employers from this saved research for professional work-email lookup. Return only people with a supplied exact LinkedIn /in/ profile URL and a corroborated current employer's official website. Use the actual named person's current company, not a previous employer, client or consultant's client. Prefer actual business users with evidenced responsibilities; technical proficiency and files may remain unknown. Do not add people from memory. Do not invent emails.`,jobId+':email-shortlist',{schema:shortlistSchema,workflow:w,stage:'work_email_shortlist',maxOutput:1800});
 const people=JSON.parse(outputText(planned)).people.filter((p:any)=>known.has(sourceKey(p.profileUrl))&&publicUrl(p.website)&&collectSources(report).some(source=>domainOf(source.url)===domainOf(p.website))&&/^https:\/\/(?:[a-z]+\.)?linkedin\.com\/in\/[^/?#]+\/?(?:\?.*)?$/.test(p.profileUrl));
 if(!people.length)return [];
 const enriched=await actorDataset(env,s,jobId+':work-email-enrichment',enrichmentActor,'0.0.141',{profileScraperMode:'Profile details + email search ($10 per 1k)',queries:people.map((p:any)=>p.profileUrl)},'linkedinUrl,email,emails,workEmail,workEmails',items=>professionalEmailRecords(items,people));
 const found:{person:any;email:string;providerRecord:any}[]=[];
 for(const record of enriched.items||[]){
  const person=people.find((p:any)=>sourceKey(p.profileUrl)===sourceKey(record.linkedinUrl));if(!person)continue;
  const possible=[record.email,record.workEmail,...(Array.isArray(record.emails)?record.emails:[]),...(Array.isArray(record.workEmails)?record.workEmails:[])];
  for(const value of possible){const email=workAddress(typeof value==='string'?value:value?.email,person.website);if(email&&value?.catchAllDomain!==true&&value?.free!==true&&!['risky','invalid','undeliverable'].includes(value?.status)&&!found.some(x=>x.email===email))found.push({person,email,providerRecord:{linkedinUrl:record.linkedinUrl,email}});}
 }
 if(!found.length)return [];
 const verified=await actorDataset(env,s,jobId+':work-email-verification',verifierActor,'2.0.12',{emails:found.map(x=>x.email),smtpCheck:true,detectCatchAll:true,checkDomainHealth:false,maxConcurrency:5,smtpTimeoutSecs:10});
 const contacts=[];
 for(const entry of found){const check=verified.items?.find(v=>cleanEmail(v.email)===entry.email);if(!verifiedMailbox(check))continue;
  contacts.push({...entry.person,email:entry.email,profileUrl:entry.person.profileUrl,companyDomain:domainOf(entry.person.website),status:'provider_verified',identityConfirmed:true,evidenceType:'provider_verification',provider:'apify/thirdwatch-email-verifier',enrichmentRunId:enriched.runId,verificationRunId:verified.runId,verification:check,observedAt:verified.completedAt,sourceUrl:`https://console.apify.com/actors/runs/${verified.runId}`,excerpt:`Provider-verified professional work email: ${entry.email}`,reason:'Matched the named professional and current company domain; separate SMTP and catch-all verification passed',deliverability:'provider_verified',limitation:'Provider evidence at verification time, not a public-page citation or guarantee of future delivery'});
 }
 return contacts;
}
