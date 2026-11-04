import type {Env,Lead,Settings,Research} from './types';
import type {Workflow} from './ai';
import {openai,outputText} from './providers';
import {collectSources,listedSource,domainOf,objectSchema,textField as str,researchSecurity,containsExcerpt,sourceKey} from './evidence';
import {cleanEmail} from './policy';
import {all,now,one,run,uid} from './db';
import {durationPolicy} from './offers';
import {publicContactReady,rejectCandidate} from './qualified-prospects';

export const contactSchema=objectSchema({email:str,sourceUrl:str,excerpt:str,identityConfirmed:{type:'boolean'},evidenceType:{type:'string',enum:['opened_page','snippet','unknown']},reason:str});
export function appropriatePublicEmail(value:unknown){const email=cleanEmail(value);return email&&!/^(?:no-?reply|privacy|abuse|careers|jobs|billing|accounts-payable)@/i.test(email)?email:null;}
export function supportedContact(parsed:any,text:string,sources:{url:string}[]){
 const email=appropriatePublicEmail(parsed.email);
 return !!email&&parsed.identityConfirmed===true&&listedSource(parsed.sourceUrl,sources)&&typeof parsed.excerpt==='string'&&parsed.excerpt.toLowerCase().includes(email)&&containsExcerpt(text,parsed.excerpt);
}
export async function researchContact(env:Env,s:Settings,lead:Lead,w:Workflow){
 const checkpoint=await one<{data:string}>(env,'SELECT data FROM pipeline_results WHERE job_id=?',w.jobId+':contact');
 if(checkpoint&&JSON.parse(checkpoint.data).policyVersion===3)return JSON.parse(checkpoint.data);
 const report=await openai(env,s,JSON.stringify({company:lead.company,website:lead.website,city:lead.city,country:lead.country,knownEmail:lead.email}),`${researchSecurity}
 Research ONLY the public business contact for this exact business and location. Open its official contact, about or team pages. Do not guess email patterns. Identify an appropriate public business mailbox, its exact source URL and a short verbatim excerpt containing the exact email. Label full opened-page evidence versus snippets. Confirm the address belongs to this business; flag conflicts. Exclude privacy, abuse, billing, careers, jobs and no-reply mailboxes. If no appropriate public email is found, explicitly report NOT FOUND. Never claim deliverability verification.`,lead.id+':contact-search',{search:true,workflow:w,stage:'contact_search',domains:lead.website?[domainOf(lead.website)]:undefined,maxOutput:1600,maxTools:3});
 const evidence=await openai(env,s,JSON.stringify({report:outputText(report),sources:collectSources(report)}),`${researchSecurity} Extract the exact public business email and verbatim excerpt from the report only. Use empty strings and identityConfirmed=false if missing or conflicting. An email must literally occur in both the report and excerpt. Keep snippets labeled snippet. A consulted URL alone is not proof of a contact.`,lead.id+':contact-extract',{schema:contactSchema,workflow:w,stage:'contact_extract',maxOutput:1600});
 let parsed=JSON.parse(outputText(evidence)),text=outputText(report),sources=collectSources(report);
 if(!supportedContact(parsed,text,sources)||parsed.evidenceType!=='opened_page'){
  const expanded=await openai(env,s,JSON.stringify({company:lead.company,website:lead.website,city:lead.city,country:lead.country,previousContact:parsed}),`${researchSecurity} A focused official-domain search did not establish an opened-page business contact. Make one bounded cross-domain pass through corroborated public trade associations and business profiles. If earlier evidence is a snippet, open its exact source page and the official contact page to confirm the quoted email. Confirm exact business identity and location, and quote any appropriate public business email verbatim with its exact source URL. Exclude privacy, abuse, billing, careers, jobs and no-reply mailboxes. Label snippets, conflicts and unknowns. Return NOT FOUND rather than guessing.`,lead.id+':contact-expand',{search:true,workflow:w,stage:'contact_expand_search',maxTools:3,maxOutput:1600});
  const extra=await openai(env,s,JSON.stringify({report:outputText(expanded),sources:collectSources(expanded)}),`${researchSecurity} Extract only the exact public business email and verbatim excerpt present in this report. Missing or conflicting email means empty strings and identityConfirmed=false. Do not guess or verify mailbox delivery.`,lead.id+':contact-expand-extract',{schema:contactSchema,workflow:w,stage:'contact_expand_extract',maxOutput:1600});
  parsed=JSON.parse(outputText(extra));text=outputText(expanded);sources=collectSources(expanded);
 }
 return saveContact(env,lead,w,parsed,text,sources,w.jobId+':contact');
}
async function saveContact(env:Env,lead:Lead,w:Workflow,parsed:any,text:string,sources:{url:string}[],checkpoint:string){
 const email=cleanEmail(parsed.email),supported=supportedContact(parsed,text,sources);
 const fresh=(await one<Lead>(env,'SELECT * FROM leads WHERE id=?',lead.id))!;
 let status=supported?(parsed.evidenceType==='opened_page'?'publicly_sourced':'needs_review'):(email?'needs_review':'not_found');
 if(supported&&fresh.email&&fresh.email!==email)status='conflicting';
 const record={...parsed,email:email||'',status,policyVersion:3,observedAt:now(),deliverability:'unknown',limitation:'AI-extracted public evidence; owner must review recipient. This is not mailbox verification.'};
 if(supported&&!fresh.email){
  const occupied=await one<any>(env,'SELECT id FROM leads WHERE email=? AND id<>?',email,lead.id);
  if(occupied){status=record.status='conflicting';record.reason='This address already belongs to another prospect; shared-recipient review required';}
  else await run(env,'UPDATE leads SET email=?,verification_note=?,updated_at=? WHERE id=? AND email IS NULL',email,`Public business email source: ${parsed.sourceUrl}; owner review required; deliverability unknown`,now(),lead.id);
 }
 await env.DB.batch([
  env.DB.prepare('UPDATE leads SET contact_status=?,contact_evidence=?,updated_at=? WHERE id=?').bind(status,JSON.stringify(record),now(),lead.id),
  env.DB.prepare('INSERT OR REPLACE INTO pipeline_results(job_id,data,created_at) VALUES(?,?,?)').bind(checkpoint,JSON.stringify(record),now())
 ]);
 return record;
}
export async function reconcileResearchContact(env:Env,s:Settings,lead:Lead,research:Research,w:Workflow){
 if(lead.email&&lead.contact_status==='publicly_sourced')return;
 const fresh=(await one<Lead>(env,'SELECT * FROM leads WHERE id=?',lead.id))!;
 if(fresh.email&&fresh.contact_status==='publicly_sourced')return;
 const key=w.jobId+':contact-reconcile';if(await one(env,'SELECT job_id FROM pipeline_results WHERE job_id=?',key))return;
 const response=await openai(env,s,JSON.stringify({business:{company:lead.company,website:lead.website,city:lead.city,country:lead.country},report:research.report,sources:research.sources}),`${researchSecurity} Reconcile a missing public business email using this SAVED business report only. Do not search or guess. Confirm exact business and location, then extract an appropriate business email, its exact consulted URL and a short continuous verbatim excerpt containing the email. Treat formatting changes as formatting only; never merge separate quotations. Do not use directory operators' mailboxes for a listed business. Label opened-page versus snippet evidence. If identity, mailbox attribution or evidence is unsupported, return empty email and explain why. This never verifies mailbox delivery.`,lead.id+':contact-reconcile',{schema:contactSchema,workflow:w,stage:'contact_reconcile_extract',maxOutput:1600});
 const parsed=JSON.parse(outputText(response));
 // Preserve useful earlier evidence if the later report adds no supported contact.
 if(supportedContact(parsed,research.report,research.sources))await saveContact(env,lead,w,parsed,research.report,research.sources,key);
 else await run(env,'INSERT OR REPLACE INTO pipeline_results(job_id,data,created_at) VALUES(?,?,?)',key,JSON.stringify({status:'not_found',reason:parsed.reason,policyVersion:2}),now());
}

// No new business research, fit analysis or draft generation until a usable
// public contact is established. Reuse saved evidence without another search.
export async function prepareInitialContact(env:Env,s:Settings,lead:Lead,w:Workflow,rewrite?:{id:string;version:number}){
 let fresh=(await one<Lead>(env,'SELECT * FROM leads WHERE id=?',lead.id))!;
 if(publicContactReady(fresh))return fresh;
 if(fresh.research){
  const saved:Research=JSON.parse(fresh.research);
  if(Date.parse(saved.gatheredAt)>=Date.now()-30*86400000){
   await reconcileResearchContact(env,s,fresh,saved,w);
   fresh=(await one<Lead>(env,'SELECT * FROM leads WHERE id=?',lead.id))!;
   if(publicContactReady(fresh))return fresh;
  }
 }
 await researchContact(env,s,fresh,w);
 fresh=(await one<Lead>(env,'SELECT * FROM leads WHERE id=?',lead.id))!;
 if(publicContactReady(fresh))return fresh;
 await rejectCandidate(env,fresh,w.jobId,'No fully sourced, appropriate public business email is available. Stopped before deeper business research, product-fit analysis and drafting.',rewrite);
 return null;
}

const factSchema=objectSchema({claim:str,sourceUrl:str,excerpt:str,evidenceType:{type:'string',enum:['opened_page','snippet']}});
const solutionSchema=objectSchema({identityConfirmed:{type:'boolean'},materialConflict:{type:'boolean'},materialConflictReason:str,businessSummary:str,existingStrengths:{type:'array',items:str},facts:{type:'array',maxItems:6,items:factSchema},hypotheses:{type:'array',items:str},unknowns:{type:'array',items:str},contradictions:{type:'array',items:str},opportunity:str,solution:objectSchema({workflow:str,input:str,action:str,output:str,scope:str,accessRequired:str,intendedBenefit:str,successMetric:str,durationDays:{type:'integer',enum:[30,45,60]},durationReason:str,whySpecific:str,factUrls:{type:'array',items:str}})});
export function solutionEvidence(d:any,research:Research){
 const facts=(d.facts||[]).slice(0,6).filter((f:any)=>typeof f.claim==='string'&&f.claim.length>=12&&listedSource(f.sourceUrl,research.sources)&&containsExcerpt(research.report,f.excerpt));
 const reasons=[];
 if(d.identityConfirmed!==true)reasons.push('Business identity is not sufficiently confirmed');
 if(d.materialConflict!==false)reasons.push(d.materialConflictReason||'Material identity or proposed-solution conflicts need review');
 if(facts.filter((f:any)=>f.evidenceType==='opened_page').length<2)reasons.push('Two substantive facts from opened pages are required');
 if((d.solution?.factUrls||[]).length<2||(d.solution?.factUrls||[]).some((u:string)=>!facts.some((f:any)=>sourceKey(f.sourceUrl)===sourceKey(u))))reasons.push('The proposed solution cites facts that are not supported by the saved excerpts');
 return {facts,qualityHold:reasons.join('; ')};
}
export async function designSolution(env:Env,s:Settings,lead:Lead,research:Research,w:Workflow){
 const checkpoint=await one<{data:string}>(env,'SELECT data FROM pipeline_results WHERE job_id=?',w.jobId+':solution');
 if(checkpoint&&JSON.parse(checkpoint.data).policyVersion===2)return JSON.parse(checkpoint.data);
 let d:any;
 if(checkpoint)d=JSON.parse(checkpoint.data);
 else{
 const response=await openai(env,s,JSON.stringify({business:{company:lead.company,website:lead.website,industry:lead.industry},research,offerContext:s.offerContext}),`${researchSecurity}
 Build a dossier and select ONE feasible working software pilot for this exact independent business. Separate observed facts, hypotheses, unknowns and contradictions. Include two or more substantive facts with exact source URLs and VERBATIM excerpts from the supplied report; do not paraphrase excerpts. Note their evidence type. Classify materialConflict using intelligence: true only for an unresolved conflict affecting this business's identity or a claim necessary for the selected solution. General unknowns, conditional future access, harmless naming/URL variants, irrelevant capacity differences and statements that no contradiction was found are not automatically material conflicts. Exclude unsupported details from the proposed solution instead of inventing them. Consider useful alternatives, then select one based on actual operations, existing strengths, feasibility and business value. Do not default to CRM or enquiry forms. Explain inputs/action/output, small scope, access and evaluation. Do not assert losses or missing systems without evidence. ${durationPolicy} If identity is weak, identityConfirmed=false. Unknown internal systems belong in unknowns.`,lead.id+':solution',{schema:solutionSchema,workflow:w,stage:'solution_design',maxOutput:3200});
 d=JSON.parse(outputText(response));}
 if(!Array.isArray(d.facts)||!d.solution)throw new Error('Invalid solution schema');
 if(solutionEvidence(d,research).qualityHold){
  const repaired=await openai(env,s,JSON.stringify({business:{company:lead.company,website:lead.website},research,previousDossier:d,validation:solutionEvidence(d,research).qualityHold}),`${researchSecurity} Review and repair this saved dossier using ONLY the saved research, without searching. Copy short continuous exact excerpts and consulted URLs. Keep snippets labeled snippet; never relabel them opened_page. Separate warnings/unknowns from material conflicts. Set materialConflict=true only for unresolved identity or evidence conflicts necessary for the proposed solution; a warning saying no contradiction was found is not a conflict. Remove unsupported solution claims and cite only accepted facts. Do not weaken identity, factual evidence, feasibility or owner-approval safeguards merely to pass validation. If the saved evidence cannot support a safe solution, retain a clear hold. ${durationPolicy}`,lead.id+':solution-evidence-repair',{schema:solutionSchema,workflow:w,stage:'solution_evidence_repair',maxOutput:3200});
  d=JSON.parse(outputText(repaired));
 }
 const {facts,qualityHold}=solutionEvidence(d,research);
 const result={...d,facts,qualityHold,policyVersion:2,observedAt:now()};
 await env.DB.batch([
  env.DB.prepare('UPDATE leads SET dossier=?,solution=?,updated_at=? WHERE id=?').bind(JSON.stringify(result),JSON.stringify(d.solution),now(),lead.id),
  ...(facts.length?[env.DB.prepare('INSERT OR IGNORE INTO business_facts(id,lead_id,job_id,claim,source_url,excerpt,evidence_type,observed_at) VALUES '+facts.map(()=>'(?,?,?,?,?,?,?,?)').join(',')).bind(...facts.flatMap((f:any)=>[uid(),lead.id,w.jobId,f.claim,f.sourceUrl,f.excerpt,f.evidenceType,now()]))]:[]),
  env.DB.prepare('INSERT OR REPLACE INTO pipeline_results(job_id,data,created_at) VALUES(?,?,?)').bind(w.jobId+':solution',JSON.stringify(result),now())
 ]);
 return result;
}

const assessmentSchema=objectSchema({specific:{type:'boolean'},supported:{type:'boolean'},feasible:{type:'boolean'},reason:str});
export async function assessDraft(env:Env,s:Settings,lead:Lead,parsed:any,research:Research,w:Workflow){
 const dossier=(await one<any>(env,'SELECT dossier,solution FROM leads WHERE id=?',lead.id))!;
 const response=await openai(env,s,JSON.stringify({business:lead.company,dossier:JSON.parse(dossier.dossier||'{}'),solution:JSON.parse(dossier.solution||'{}'),research,draft:parsed}),`${researchSecurity}
 Assess this exact draft. specific=true only when the actual service/product/workflow details make it meaningfully different from a name-swapped generic email. supported=true only when every material business claim is grounded in supplied evidence, and hypothesized problems stay conditional. feasible=true only for one small working pilot with appropriate access, a consistent 30/45/60-day period and no guaranteed results or unlimited work. Reject invented losses, assumed missing internal systems, deceptive urgency and documents as the main deliverable. Keep reason under 45 words and give an actionable reason for any false value. Do not rewrite or send.`,lead.id+':assessment',{schema:assessmentSchema,workflow:w,stage:'draft_assess',maxOutput:1600});
 const result=JSON.parse(outputText(response));
 if(!['specific','supported','feasible'].every(k=>typeof result[k]==='boolean'))throw new Error('Invalid draft assessment');
 return result;
}
