import type {Env,Lead,Settings,Research} from './types';
import type {Workflow} from './ai';
import {openai,outputText} from './providers';
import {collectSources,listedSource,domainOf,objectSchema,textField as str,researchSecurity} from './evidence';
import {cleanEmail} from './policy';
import {all,now,one,run,uid} from './db';
import {durationPolicy} from './offers';

const contactSchema=objectSchema({email:str,sourceUrl:str,excerpt:str,identityConfirmed:{type:'boolean'},evidenceType:{type:'string',enum:['opened_page','snippet','unknown']},reason:str});
export async function researchContact(env:Env,s:Settings,lead:Lead,w:Workflow){
 const checkpoint=await one<{data:string}>(env,'SELECT data FROM pipeline_results WHERE job_id=?',w.jobId+':contact');
 if(checkpoint)return JSON.parse(checkpoint.data);
 const report=await openai(env,s,JSON.stringify({company:lead.company,website:lead.website,city:lead.city,country:lead.country,knownEmail:lead.email}),`${researchSecurity}
 Research ONLY the public business contact for this exact business and location. Open its official contact, about or team pages. Do not guess email patterns. Identify an appropriate public business mailbox, its exact source URL and a short verbatim excerpt containing the exact email. Label full opened-page evidence versus snippets. Confirm the address belongs to this business; flag conflicts. Exclude privacy, abuse, billing, careers, jobs and no-reply mailboxes. If no appropriate public email is found, explicitly report NOT FOUND. Never claim deliverability verification.`,lead.id+':contact-search',{search:true,workflow:w,stage:'contact_search',domains:lead.website?[domainOf(lead.website)]:undefined,maxOutput:1600,maxTools:3});
 const evidence=await openai(env,s,JSON.stringify({report:outputText(report),sources:collectSources(report)}),`${researchSecurity} Extract the exact public business email and verbatim excerpt from the report only. Use empty strings and identityConfirmed=false if missing or conflicting. An email must literally occur in both the report and excerpt. Keep snippets labeled snippet. A consulted URL alone is not proof of a contact.`,lead.id+':contact-extract',{schema:contactSchema,workflow:w,stage:'contact_extract',maxOutput:900});
 let parsed=JSON.parse(outputText(evidence)),text=outputText(report),sources=collectSources(report);
 if(!cleanEmail(parsed.email)){
  const expanded=await openai(env,s,JSON.stringify({company:lead.company,website:lead.website,city:lead.city,country:lead.country}),`${researchSecurity} A focused official-domain search did not establish a contact. Make one bounded cross-domain pass through corroborated public trade associations and business profiles. Confirm exact business identity and location, and quote any public business email verbatim with its exact source URL. Label snippets, conflicts and unknowns. Return NOT FOUND rather than guessing.`,lead.id+':contact-expand',{search:true,workflow:w,stage:'contact_expand_search',maxTools:3,maxOutput:1600});
  const extra=await openai(env,s,JSON.stringify({report:outputText(expanded),sources:collectSources(expanded)}),`${researchSecurity} Extract only the exact public business email and verbatim excerpt present in this report. Missing or conflicting email means empty strings and identityConfirmed=false. Do not guess or verify mailbox delivery.`,lead.id+':contact-expand-extract',{schema:contactSchema,workflow:w,stage:'contact_expand_extract',maxOutput:900});
  parsed=JSON.parse(outputText(extra));text=outputText(expanded);sources=collectSources(expanded);
 }
 const email=cleanEmail(parsed.email);
 const supported=!!email&&parsed.identityConfirmed===true&&listedSource(parsed.sourceUrl,sources)&&typeof parsed.excerpt==='string'&&parsed.excerpt.length>=15&&parsed.excerpt.toLowerCase().includes(email)&&text.toLowerCase().includes(parsed.excerpt.toLowerCase())&&!/^(?:no-?reply|privacy|abuse|careers|jobs|billing|accounts-payable)@/i.test(email);
 const fresh=(await one<Lead>(env,'SELECT * FROM leads WHERE id=?',lead.id))!;
 let status=supported?(parsed.evidenceType==='opened_page'?'publicly_sourced':'needs_review'):(email?'needs_review':'not_found');
 if(supported&&fresh.email&&fresh.email!==email)status='conflicting';
 const record={...parsed,email:email||'',status,observedAt:now(),deliverability:'unknown',limitation:'AI-extracted public evidence; owner must review recipient. This is not mailbox verification.'};
 if(supported&&!fresh.email){
  const occupied=await one<any>(env,'SELECT id FROM leads WHERE email=? AND id<>?',email,lead.id);
  if(occupied){status=record.status='conflicting';record.reason='This address already belongs to another prospect; shared-recipient review required';}
  else await run(env,'UPDATE leads SET email=?,verification_note=?,updated_at=? WHERE id=? AND email IS NULL',email,`Public business email source: ${parsed.sourceUrl}; owner review required; deliverability unknown`,now(),lead.id);
 }
 await env.DB.batch([
  env.DB.prepare('UPDATE leads SET contact_status=?,contact_evidence=?,updated_at=? WHERE id=?').bind(status,JSON.stringify(record),now(),lead.id),
  env.DB.prepare('INSERT OR REPLACE INTO pipeline_results(job_id,data,created_at) VALUES(?,?,?)').bind(w.jobId+':contact',JSON.stringify(record),now())
 ]);
 return record;
}

const factSchema=objectSchema({claim:str,sourceUrl:str,excerpt:str,evidenceType:{type:'string',enum:['opened_page','snippet']}});
const solutionSchema=objectSchema({identityConfirmed:{type:'boolean'},businessSummary:str,existingStrengths:{type:'array',items:str},facts:{type:'array',maxItems:6,items:factSchema},hypotheses:{type:'array',items:str},unknowns:{type:'array',items:str},contradictions:{type:'array',items:str},opportunity:str,solution:objectSchema({workflow:str,input:str,action:str,output:str,scope:str,accessRequired:str,intendedBenefit:str,successMetric:str,durationDays:{type:'integer',enum:[30,45,60]},durationReason:str,whySpecific:str,factUrls:{type:'array',items:str}})});
export async function designSolution(env:Env,s:Settings,lead:Lead,research:Research,w:Workflow){
 const checkpoint=await one<{data:string}>(env,'SELECT data FROM pipeline_results WHERE job_id=?',w.jobId+':solution');
 if(checkpoint)return JSON.parse(checkpoint.data);
 const response=await openai(env,s,JSON.stringify({business:{company:lead.company,website:lead.website,industry:lead.industry},research,offerContext:s.offerContext}),`${researchSecurity}
 Build a dossier and select ONE feasible working software pilot for this exact independent business. Separate observed facts, hypotheses, unknowns and contradictions. Include two or more substantive facts with exact source URLs and VERBATIM excerpts from the supplied report; do not paraphrase excerpts. Note their evidence type. Consider a few useful alternatives internally, then select one based on the observed services, products and actual customer workflow, existing strengths, operational fit, business value, access needs and feasibility for one builder. Do not default to quote follow-ups, CRM or enquiry forms for every business. Explain inputs/action/output, smallest useful scope, intended benefit and evaluation. Do not assert lost revenue, failed follow-ups or missing systems unless actually evidenced. ${durationPolicy} If identity or evidence is weak, identityConfirmed=false and explain it in contradictions/unknowns rather than inventing facts.`,lead.id+':solution',{schema:solutionSchema,workflow:w,stage:'solution_design',maxOutput:2800});
 const d=JSON.parse(outputText(response));if(!Array.isArray(d.facts)||!d.solution)throw new Error('Invalid solution schema');
 const facts=d.facts.slice(0,6).filter((f:any)=>typeof f.claim==='string'&&f.claim.length>=12&&listedSource(f.sourceUrl,research.sources)&&typeof f.excerpt==='string'&&f.excerpt.length>=15&&research.report.includes(f.excerpt));
 const hold=d.identityConfirmed!==true||facts.filter((f:any)=>f.evidenceType==='opened_page').length<2||(d.contradictions||[]).length>0||(d.solution.factUrls||[]).some((u:string)=>!facts.some((f:any)=>f.sourceUrl===u))||(d.solution.factUrls||[]).length<2;
 const result={...d,facts,qualityHold:hold?'Business identity, factual excerpts or solution evidence need stronger research':'',observedAt:now()};
 await env.DB.batch([
  env.DB.prepare('UPDATE leads SET dossier=?,solution=?,updated_at=? WHERE id=?').bind(JSON.stringify(result),JSON.stringify(d.solution),now(),lead.id),
  ...facts.map((f:any)=>env.DB.prepare('INSERT OR IGNORE INTO business_facts(id,lead_id,job_id,claim,source_url,excerpt,evidence_type,observed_at) VALUES(?,?,?,?,?,?,?,?)').bind(uid(),lead.id,w.jobId,f.claim,f.sourceUrl,f.excerpt,f.evidenceType,now())),
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
