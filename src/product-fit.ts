import type {Env} from './types';
import {objectSchema,textField as str,listedSource,containsExcerpt} from './evidence';

export const useCaseSchema=objectSchema({id:str,buyerRole:str,workflow:str,productCapability:str,capabilityEvidence:objectSchema({sourceType:{type:'string',enum:['official_page','owner_description','owner_remarks']},sourceUrl:str,excerpt:str}),fitSignals:{type:'array',minItems:1,maxItems:4,items:str},poorFitSignals:{type:'array',maxItems:4,items:str},searchPhrases:{type:'array',minItems:2,maxItems:4,items:str}});
export const fitSignalSchema=objectSchema({useCaseId:str,observedWorkflow:str,productCapability:str,whyRelevant:str,sourceUrl:str,excerpt:str,evidenceType:{type:'string',enum:['opened_page','snippet','unknown']},disqualifierFound:{type:'boolean'}});
export interface ProductUseCase {id:string;buyerRole:string;workflow:string;productCapability:string;capabilityEvidence:{sourceType:string;sourceUrl:string;excerpt:string};fitSignals:string[];poorFitSignals:string[];searchPhrases:string[]}
export function productUseCases(env:Env):ProductUseCase[]{
 try{const cases=JSON.parse(env.PRODUCT_BRIEF||'{}').approvedCustomerProfile?.useCases;return Array.isArray(cases)?cases:[];}catch{return [];}
}
export function validUseCases(cases:unknown):cases is ProductUseCase[]{
 if(!Array.isArray(cases)||!cases.length||cases.length>6||cases.some(c=>!c||typeof c!=='object'))return false;
 return new Set(cases.map(c=>c.id)).size===cases.length&&cases.every(c=>typeof c.id==='string'&&/^[a-z0-9_-]{1,60}$/.test(c.id)&&[c.buyerRole,c.workflow,c.productCapability].every(s=>typeof s==='string'&&s.trim().length>=8)&&Array.isArray(c.fitSignals)&&c.fitSignals.length>0&&c.fitSignals.every((s:unknown)=>typeof s==='string'&&s.trim().length>=15)&&Array.isArray(c.poorFitSignals)&&Array.isArray(c.searchPhrases)&&c.searchPhrases.length>=2&&c.searchPhrases.every((q:unknown)=>typeof q==='string'&&q.trim().length>=8&&q.length<=150));
}

export function supportedCapability(c:ProductUseCase,product:{description:string;remarks:string},report:string,sources:{url:string}[]){
 const evidence=c.capabilityEvidence;if(!evidence)return false;
 return evidence.sourceType==='owner_description'?containsExcerpt(product.description,evidence.excerpt):evidence.sourceType==='owner_remarks'?containsExcerpt(product.remarks,evidence.excerpt):evidence.sourceType==='official_page'&&listedSource(evidence.sourceUrl,sources)&&containsExcerpt(report,evidence.excerpt);
}
export function productFitProblems(env:Env,signal:any,report:string,sources:{url:string}[],facts?:{url:string;excerpt:string}[]){
 const cases=productUseCases(env),useCase=cases.find(c=>c.id===signal?.useCaseId),problems:string[]=[];
 if(!useCase)return ['No supported product use case matches the candidate'];
 if(signal.productCapability!==useCase.productCapability)problems.push('Claimed capability does not match the product profile');
 if(signal.disqualifierFound!==false)problems.push('A material product or owner-targeting exclusion applies');
 if([signal.observedWorkflow,signal.whyRelevant].some(v=>typeof v!=='string'||v.trim().length<20))problems.push('No specific workflow and capability mapping was provided');
 if(signal.evidenceType!=='opened_page'||!listedSource(signal.sourceUrl,sources)||!containsExcerpt(report,signal.excerpt))problems.push('The workflow fit has no exact, consulted opened-page evidence');
 if(facts&&!facts.some(f=>listedSource(signal.sourceUrl,[f])&&containsExcerpt(f.excerpt,signal.excerpt)))problems.push('The workflow mapping is not supported by an accepted business fact');
 return problems;
}
export const productFitInstructions='Match a specific useCases entry in the product profile. Industry, company size, a generic job title, or an email address alone never establish product fit. Find evidenced responsibilities, data-related activity, an observed workflow or an explicitly stated professional need matching the use case’s fitSignals. Do not require a recurring report, cadence or publicly stated pain unless the owner explicitly requests it. Attribute it to the actual prospect: a consultant’s case study about its client is not evidence that the consultant has that internal need. Distinguish the intended product buyer from a competing vendor, referral partner or directory operator unless the owner explicitly targets those roles; explain which exact existing product capability helps and why. Copy its useCaseId and productCapability exactly. Do not manufacture a pain point, buying intent, compatibility, or a missing internal system. Check poorFitSignals and owner exclusions; reject a proven essential incompatibility. Internal file format, purchasing budget and willingness may remain unknown and must be phrased conditionally. Prefer the most directly evidenced workflow over broad sector similarity.';
