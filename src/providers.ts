import type { Env, Settings } from './types';
import { reserve, settle, uncertainExpense } from './db';

export class ProviderError extends Error { constructor(public provider:string,public status:number,public code=''){super(`${provider} returned HTTP ${status}${code?' ('+code+')':''}`);} }
export class UncertainProviderError extends Error { constructor(provider:string){super(`${provider} request outcome is uncertain. Inspect provider records before starting new paid work.`);} }
export async function jsonRequest<T=any>(provider:string,url:string,init:RequestInit={},timeout=25000):Promise<T> {
 const response=await fetch(url,{...init,signal:AbortSignal.timeout(timeout)});
 if(!response.ok) {
  // Keep provider error codes for quota/auth diagnosis, without logging bodies,
  // URLs or headers that may contain credentials or personal information.
  let code='';try{const data:any=await response.json();const candidate=data.error?.code||data.error?.type||data.errors?.[0]?.id;if(typeof candidate==='string'&&/^[a-zA-Z0-9_.-]{1,80}$/.test(candidate))code=candidate;}catch{}
  throw new ProviderError(provider,response.status,code);
 }
 return response.json() as Promise<T>;
}
export const rates:Record<string,{input:number;output:number}>={
 'gpt-5.6-sol':{input:4,output:20},'gpt-5.4-mini':{input:0.75,output:4.5}
};
export function outputText(response:any):string {
 return (response.output||[]).filter((x:any)=>x.type==='message').flatMap((x:any)=>x.content||[]).filter((x:any)=>x.type==='output_text').map((x:any)=>x.text).join('\n');
}
export {requestOpenAI as openai} from './ai';
export async function googleAccessToken(env:Env) {
 if(!env.GOOGLE_CLIENT_ID||!env.GOOGLE_CLIENT_SECRET||!env.GOOGLE_REFRESH_TOKEN) throw new Error('Google OAuth credentials are missing');
 const data=await jsonRequest('Google OAuth','https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,refresh_token:env.GOOGLE_REFRESH_TOKEN,grant_type:'refresh_token'})});
 if(!data.access_token) throw new Error('Google returned no access token');
 return data.access_token as string;
}
export async function gmail(env:Env,path:string,init:RequestInit={},token?:string) {
 return jsonRequest('Gmail',`https://gmail.googleapis.com/gmail/v1/users/me/${path}`,{...init,headers:{Authorization:`Bearer ${token||await googleAccessToken(env)}`,'Content-Type':'application/json',...init.headers}});
}
export function base64url(text:string) { return Buffer.from(text,'utf8').toString('base64url'); }
export function mimeMessage(params:{from:string;name:string;to:string;subject:string;body:string;messageId:string;replyToId?:string|null;unsubscribe?:string}) {
 for(const value of [params.from,params.to,params.name,params.subject,params.messageId,params.replyToId||'']) if(/[\r\n]/.test(value)) throw new Error('Email header contains a newline');
 const headers=[`From: =?UTF-8?B?${Buffer.from(params.name).toString('base64')}?= <${params.from}>`,`To: ${params.to}`,`Subject: =?UTF-8?B?${Buffer.from(params.subject).toString('base64')}?=`,`Message-ID: ${params.messageId}`,'MIME-Version: 1.0','Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64'];
 if(params.replyToId) headers.push(`In-Reply-To: ${params.replyToId}`,`References: ${params.replyToId}`);
 if(params.unsubscribe) headers.push(`List-Unsubscribe: <${params.unsubscribe}>`,'List-Unsubscribe-Post: List-Unsubscribe=One-Click');
 const encoded=Buffer.from(params.body,'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n')||'';
 return base64url(headers.join('\r\n')+'\r\n\r\n'+encoded);
}
export async function sendGmail(env:Env,raw:string,threadId?:string|null) {
 return gmail(env,'messages/send',{method:'POST',body:JSON.stringify({raw,...(threadId?{threadId}: {})})});
}
export async function telegram(env:Env,text:string) {
 if(!env.TELEGRAM_BOT_TOKEN||!env.TELEGRAM_CHAT_ID) throw new Error('Telegram credentials are missing');
 const data=await jsonRequest('Telegram',`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:env.TELEGRAM_CHAT_ID,text,link_preview_options:{is_disabled:true}})});
 if(!data.ok) throw new Error('Telegram did not accept the notification');
}
