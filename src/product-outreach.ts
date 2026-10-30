import type {Env,Settings,Lead,Draft,Research,Evidence} from './types';
import type {Workflow} from './ai';
import {openai,outputText} from './providers';
import {all,one,run,now,uid} from './db';
import {researchContact,reconcileResearchContact} from './intelligence';
import {objectSchema,textField as str,collectSources,meaningfulSources,listedSource,researchSecurity,containsExcerpt} from './evidence';
import {requireProductReady,assertProductCurrent} from './products';
import {conversationReady,followupDraftReady} from './followups';

const fact=objectSchema({claim:str,url:str,excerpt:str,evidenceType:{type:'string',enum:['opened_page','snippet']}});
const dossierSchema=objectSchema({businessSummary:str,qualified:{type:'boolean'},qualificationReason:str,materialConflict:{type:'boolean'},materialConflictReason:str,facts:{type:'array',maxItems:6,items:fact},hypotheses:{type:'array',items:str},unknowns:{type:'array',items:str},productUseCase:str,whySpecific:str,solution:str});
const evidence=objectSchema({observation:str,url:str,kind:{type:'string',enum:['observed','hypothesis']},relevance:str});
const draftSchema=objectSchema({qualified:{type:'boolean'},holdReason:str,subject:str,body:str,score:{type:'integer',minimum:0,maximum:100},opportunity:str,evidence:{type:'array',maxItems:6,items:evidence},warnings:{type:'array',items:str},remarksApplied:{type:'array',items:str}});
const assessSchema=objectSchema({specific:{type:'boolean'},supported:{type:'boolean'},appropriate:{type:'boolean'},reason:str});
export async function draftProductLead(env:Env,s:Settings,lead:Lead,kind:Draft['kind'],inboundId:string|undefined,rewrite:{id:string;version:number}|undefined,w:Workflow){
 requireProductReady(env);
 if(!await conversationReady(env,lead,kind,s))return;
 const existing=rewrite?await one<Draft>(env,"SELECT * FROM drafts WHERE id=? AND lead_id=? AND version=? AND status='pending'",rewrite.id,lead.id,rewrite.version):null;
 if(rewrite&&!existing)return;
 if(!rewrite&&await one(env,"SELECT id FROM drafts WHERE lead_id=? AND status IN ('pending','approved','sending','uncertain')",lead.id))return;
 if(kind==='initial')await researchContact(env,s,lead,w);
 let research:Research=lead.research?JSON.parse(lead.research):null;
 if(!research||kind==='initial'&&Date.now()-Date.parse(research.gatheredAt)>30*86400000){
  const report=await openai(env,s,JSON.stringify({business:{company:lead.company,website:lead.website,city:lead.city,country:lead.country}}),`${researchSecurity} Research this exact business and its identity, real products/services, workflow and public contact journey. Use its official website and corroborating independent sources; seek at least three useful pages across two domains. Include short VERBATIM excerpts for two substantive observations with exact source URLs. Evaluate fit for the supplied PRODUCT and owner remarks, not a generic software consulting pitch. Distinguish facts, hypotheses and unknowns. Never assert internal problems, lost revenue or missing systems without evidence. Do not invent product capabilities or commercial offers.`,lead.id+':product-business',{search:true,workflow:w,stage:'business_research',maxOutput:3500,maxTools:4});
  research={report:outputText(report),sources:collectSources(report),gatheredAt:now()};
  await run(env,'UPDATE leads SET research=?,research_at=?,updated_at=? WHERE id=?',JSON.stringify(research),research.gatheredAt,now(),lead.id);
 }
 const r=research!;
 if(kind==='initial')await reconcileResearchContact(env,s,lead,r,w);
 const fit=await openai(env,s,JSON.stringify({business:lead.company,research:r}),`${researchSecurity} Analyze actual fit between this business and the supplied PRODUCT profile, description and remarks. Separate quoted facts from hypotheses and unknowns. Choose a specific existing product capability/use case that addresses a plausible business need; explain why it follows from this business's observed operations. Do not invent features, losses, missing internal systems, free trials or promises to build custom work. Return qualified=false when evidence or fit is weak. Facts must contain exact consulted URLs and continuous verbatim excerpts from the report. Preserve opened_page versus snippet evidence; never upgrade snippets. Set materialConflict=true only for unresolved conflicts affecting identity or claims needed for this product use case. General unknowns, harmless naming/URL variants and irrelevant differences are warnings, not automatic blockers; omit unsupported details from the solution.`,lead.id+':product-fit',{schema:dossierSchema,workflow:w,stage:'solution_design',maxOutput:2400});
 let dossier=JSON.parse(outputText(fit));
 const acceptedFacts=(d:any)=>d.facts.filter((f:any)=>listedSource(f.url,r.sources)&&containsExcerpt(r.report,f.excerpt));
 if(dossier.qualified&&(acceptedFacts(dossier).filter((f:any)=>f.evidenceType==='opened_page').length<2||dossier.materialConflict!==false)){
  const repair=await openai(env,s,JSON.stringify({research:r,previousDossier:dossier}),`${researchSecurity} Repair the factual excerpts in this saved product-fit dossier without searching again. Each fact must have a consulted source URL and a short exact continuous excerpt copied from the research report. No paraphrasing, invented problems or altered product terms. Keep facts separate from hypotheses. Preserve opened_page versus snippet provenance, never upgrading snippets. Classify materialConflict only for unresolved conflicts affecting identity or necessary solution claims. Return qualified=false if two substantive opened-page facts cannot be established. Keep genuine identity and evidence gaps held for review.`,lead.id+':fit-evidence-repair',{schema:dossierSchema,workflow:w,stage:'solution_evidence_repair',maxOutput:2400});
  dossier=JSON.parse(outputText(repair));
 }
 const facts=acceptedFacts(dossier);
 const hold=!dossier.qualified||dossier.materialConflict!==false||facts.filter((f:any)=>f.evidenceType==='opened_page').length<2||!meaningfulSources(r.sources);
 dossier.facts=facts;
 await env.DB.batch([
  env.DB.prepare('UPDATE leads SET dossier=?,solution=?,updated_at=? WHERE id=?').bind(JSON.stringify(dossier),JSON.stringify({productId:env.PRODUCT_ID,useCase:dossier.productUseCase,solution:dossier.solution}),now(),lead.id),
  ...(facts.length?[env.DB.prepare('INSERT OR IGNORE INTO business_facts(id,lead_id,job_id,claim,source_url,excerpt,evidence_type,observed_at) VALUES '+facts.map(()=>'(?,?,?,?,?,?,?,?)').join(',')).bind(...facts.flatMap((f:any)=>[uid(),lead.id,w.jobId,f.claim,f.url,f.excerpt,f.evidenceType,now()]))]:[])
 ]);
 const messages=await all<any>(env,'SELECT direction,subject,body,rfc_id FROM messages WHERE lead_id=? ORDER BY created_at DESC LIMIT 8',lead.id);
 const previous=await one<Draft>(env,"SELECT * FROM drafts WHERE lead_id=? AND status='sent' ORDER BY created_at DESC LIMIT 1",lead.id);
 const result=await openai(env,s,JSON.stringify({kind,revisionRequest:existing?{currentBody:existing.body,qualityHold:existing.quality_hold}:undefined,followupNumber:kind==='followup'?lead.followup_count+1:undefined,maximumFollowups:3,business:{company:lead.company,contact:lead.contact_name},research:r,dossier,messages,previous:previous?{body:previous.body,subject:previous.subject}:null}),`${researchSecurity} Draft a concise, individually researched ${kind} email FROM ${s.senderName} about this exact PRODUCT. Use the supplied product description, approved customer profile and ALL relevant owner remarks for message framing, target need and CTA. Connect at least two observed business details to one actual product capability/use case. A name swap must not make it equally applicable to another business. Initial body should be 65-115 words. No greeting or footer; the app adds these. Do not insert sender biography unless supplied by the owner. Do not promise free trials, discounts, implementation work, ROI or features unless the product details/remarks explicitly authorize them. No generic software-consulting or standard pilot template. Explain the likely benefit conditionally. Every material business claim must be sourced. If weak or contradictory, set qualified=false and explain the hold. When revisionRequest is supplied, fix its qualityHold using supported facts only. Access to internal systems, order status or customer data always requires future agreement and authorization; never assume it. For follow-ups retain the previously offered product and terms; use followupNumber and the entire supplied history to write a distinct continuation, never a duplicate reminder. Do not claim delivery or opening. The third follow-up politely closes the loop. for replies answer the actual incoming message without unauthorized commitments. Provide a low-pressure CTA and list which owner remarks you applied. Never send.`,lead.id+':product-draft',{schema:draftSchema,workflow:w,stage:'draft_generate',maxOutput:2200});
 const parsed=JSON.parse(outputText(result));
 const observed:Evidence[]=parsed.evidence.filter((e:Evidence)=>listedSource(e.url,r.sources)&&['observed','hypothesis'].includes(e.kind));
 const assessment=await openai(env,s,JSON.stringify({product:env.PRODUCT_BRIEF,business:lead.company,research:r,dossier,draft:parsed}),`${researchSecurity} Independently assess this product-specific email. specific requires business-specific facts and a relevant actual product use case. supported requires grounded business claims and product capabilities; keep unproven problems conditional. appropriate requires all relevant owner remarks, approved targeting, accurate product terms, no invented trials/pricing/custom implementation and a reasonable CTA. Reject generic name-swapped pitches. Explain failures in under 45 words. Do not rewrite or send.`,lead.id+':product-assess',{schema:assessSchema,workflow:w,stage:'draft_assess',maxOutput:1600});
 const a=JSON.parse(outputText(assessment)),quality=hold||!parsed.qualified||!a.specific||!a.supported||!a.appropriate||observed.filter(e=>e.kind==='observed').length<2;
 const reason=quality?(parsed.holdReason||(!a.specific||!a.supported||!a.appropriate?a.reason:'Business fit or source evidence needs review')):'';
 const offer=JSON.stringify({type:'product',productId:env.PRODUCT_ID,remarksApplied:parsed.remarksApplied,useCase:dossier.productUseCase});
 await assertProductCurrent(env);
 const greeting=String(lead.contact_name||lead.company+' team').replace(/[\r\n]/g,' '),body=`Hi ${greeting},\n\n${String(parsed.body).trim()}`,subject=String(kind==='reply'?(messages.find(m=>m.direction==='inbound')?.subject||previous?.subject||parsed.subject):kind==='followup'?(previous?.subject||parsed.subject):parsed.subject).replace(/[\r\n]/g,' ').slice(0,180);
 if(rewrite){await run(env,"UPDATE drafts SET subject=?,body=?,artifact='',evidence=?,rationale=?,warnings=?,quality_hold=?,free_offer=?,version=version+1,approved_version=NULL,approved_hash=NULL,approved_at=NULL,updated_at=? WHERE id=? AND version=? AND status='pending'",subject,body,JSON.stringify(observed),parsed.opportunity,JSON.stringify(parsed.warnings),reason,offer,now(),rewrite.id,rewrite.version);return;}
 const inbound=inboundId?await one<any>(env,'SELECT rfc_id FROM messages WHERE id=?',inboundId):null,id=uid();
 if(!await conversationReady(env,lead,kind,s))return;
 await env.DB.batch([
  env.DB.prepare('INSERT INTO drafts(id,lead_id,kind,subject,body,evidence,rationale,warnings,quality_hold,free_offer,in_reply_to,inbound_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(id,lead.id,kind,subject,body,JSON.stringify(observed),parsed.opportunity,JSON.stringify(parsed.warnings),reason,offer,inbound?.rfc_id||previous?.message_id||null,inboundId||null,now(),now()),
  env.DB.prepare("UPDATE leads SET status=CASE WHEN ?='initial' THEN 'review' ELSE status END,opportunity=?,score=?,updated_at=? WHERE id=?").bind(kind,parsed.opportunity,parsed.score,now(),lead.id),
  env.DB.prepare('INSERT OR REPLACE INTO pipeline_results VALUES(?,?,?)').bind(w.jobId,JSON.stringify({draftId:id,assessment:a,qualityHold:reason}),now())
 ]);
 await followupDraftReady(env,lead,kind,id);
}
