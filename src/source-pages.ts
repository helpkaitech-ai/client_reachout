import type {Env} from './types';
import {one,run,now} from './db';
import {publicUrl,cleanEmail} from './policy';
import {domainOf,sourceKey,containsExcerpt,type Source} from './evidence';

export interface SourcePage {url:string;finalUrl:string;text:string;fetchedAt:string;contactLinks?:string[];provider?:'apify';providerRunId?:string}
const BYTE_LIMIT=384*1024;
function decode(text:string){return text.replace(/&#(x[\da-f]+|\d+);|&(amp|quot|apos|lt|gt|nbsp);/gi,(whole,namedCode,name)=>{
 if(namedCode){const n=namedCode[0].toLowerCase()==='x'?parseInt(namedCode.slice(1),16):Number(namedCode);return n>0&&n<=0x10ffff?String.fromCodePoint(n):whole;}
 return ({amp:'&',quot:'"',apos:"'",lt:'<',gt:'>',nbsp:' '} as Record<string,string>)[name.toLowerCase()]||whole;
});}
export function pageText(html:string){
 const visible=html.replace(/<!--[\s\S]*?-->/g,' ').replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,' '),emails=new Set<string>();
 for(const link of visible.matchAll(/<a\b[^>]*href\s*=\s*["']mailto:([^"']+)["'][^>]*>/gi)){
  try{const email=cleanEmail(decodeURIComponent(decode(link[1]).split('?')[0]));if(email)emails.add(email);}catch{}
 }
 const text=decode(visible.replace(/<[^>]*>/g,' ')).replace(/\s+/g,' ').trim().slice(0,44000);
 return text+(emails.size?'\nPublished mailto links: '+[...emails].join(' · '):'');
}
function contactLinks(html:string,base:string){
 const found:string[]=[];
 for(const match of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)){
  try{const url=publicUrl(new URL(decode(match[1]),base).href);if(url&&domainOf(url)===domainOf(base)&&/\b(contact|contact-us|get-in-touch)\b/i.test(new URL(url).pathname+' '+pageText(match[2])))found.push(url);}catch{}
 }
 return [...new Set(found)].slice(0,3);
}
export async function fetchSourcePage(input:string):Promise<SourcePage|null>{
 const original=publicUrl(input);if(!original)return null;
 const signal=AbortSignal.timeout(10000);let url=original;
 try{
  for(let redirects=0;redirects<4;redirects++){
   const response=await fetch(url,{redirect:'manual',signal,headers:{Accept:'text/html,text/plain;q=0.9','User-Agent':'Relay prospect research (public business pages)'}});
   if(response.status>=300&&response.status<400){const location=response.headers.get('location');await response.body?.cancel();const next=location&&publicUrl(new URL(location,url).href);if(!next||domainOf(next)!==domainOf(original))return null;url=next;continue;}
   if(!response.ok||!/^(text\/html|text\/plain|application\/xhtml\+xml)/i.test(response.headers.get('content-type')||'')){await response.body?.cancel();return null;}
   if(!response.body)return null;
   const reader=response.body.getReader(),decoder=new TextDecoder();let bytes=0,html='';
   try{while(true){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>BYTE_LIMIT){await reader.cancel();return null;}html+=decoder.decode(chunk.value,{stream:true});}html+=decoder.decode();}finally{reader.releaseLock();}
   const text=pageText(html);return text.length>=40?{url:original,finalUrl:url,text,fetchedAt:now(),contactLinks:contactLinks(html,url)}:null;
  }
 }catch{/* A blocked or unavailable page is missing evidence, never a verified page. */}
 return null;
}
// Saved snapshots prevent re-fetching a changing page between paid checkpoints.
export async function sourcePages(env:Env,key:string,urls:string[]):Promise<SourcePage[]>{
 const saved=await one<{data:string}>(env,'SELECT data FROM pipeline_results WHERE job_id=?',key);if(saved)return JSON.parse(saved.data).pages;
 const unique=[...new Map(urls.filter(u=>publicUrl(u)).map(u=>[sourceKey(u),u])).values()].slice(0,8),pages:SourcePage[]=[];
 for(let i=0;i<unique.length;i+=3){const results=await Promise.all(unique.slice(i,i+3).map(fetchSourcePage));for(const page of results)if(page)pages.push(page);}
 // Once businesses are known, follow their actual official contact links. These
 // requests do not add email/file-format restrictions to discovery queries.
 const domains=new Set<string>(),contacts:string[]=[];
 for(const page of pages){const domain=domainOf(page.url);if(domains.has(domain))continue;domains.add(domain);const link=page.contactLinks?.find(url=>!unique.some(u=>sourceKey(u)===sourceKey(url)));if(link)contacts.push(link);}
 const extra=contacts.slice(0,Math.min(4,12-unique.length));
 for(let i=0;i<extra.length;i+=3){const results=await Promise.all(extra.slice(i,i+3).map(fetchSourcePage));for(const page of results)if(page)pages.push(page);}
 await run(env,'INSERT OR IGNORE INTO pipeline_results(job_id,data,created_at) VALUES(?,?,?)',key,JSON.stringify({pages,attemptedUrls:[...unique,...extra]}),now());return pages;
}
export function citedPages(response:any){return [...new Set<string>((response.output||[]).flatMap((item:any)=>(item.content||[]).flatMap((c:any)=>(c.annotations||[]).filter((a:any)=>a.url).map((a:any)=>String(a.url)))))];}
export function pageEvidence(report:string,pages:SourcePage[]){return report+'\n\nDIRECTLY FETCHED PUBLIC PAGE SNAPSHOTS (quote text only; URLs identify provenance):\n'+pages.map(p=>`SOURCE URL: ${p.url}\nFINAL URL: ${p.finalUrl}\nEVIDENCE TYPE: opened_page${p.provider?` (public professional profile retrieved by ${p.provider}, run ${p.providerRunId})`:""}\nPAGE TEXT: ${p.text}`).join('\n\n');}
export function evidenceSources(sources:Source[],pages:SourcePage[]):Source[]{const map=new Map(sources.map(s=>[sourceKey(s.url),s]));for(const p of pages)map.set(sourceKey(p.url),{url:p.url,title:map.get(sourceKey(p.url))?.title||new URL(p.url).hostname,evidenceType:'opened_page'});return [...map.values()];}
export function groundedExcerpt(url:string,excerpt:string,report:string,sources:Source[],pages:SourcePage[]){
 const snapshot=pages.find(p=>sourceKey(p.url)===sourceKey(url));
 // When the real page was fetched, its text is authoritative over a model's report.
 return snapshot?containsExcerpt(snapshot.text,excerpt):sources.some(s=>sourceKey(s.url)===sourceKey(url)&&s.evidenceType==='opened_page')&&containsExcerpt(report,excerpt);
}
