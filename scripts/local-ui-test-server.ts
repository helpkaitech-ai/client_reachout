import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import worker from '../src/index';
import {database,readyLead,readyDraft,testSettings} from '../tests/helpers';
import {run} from '../src/db';
import {mockOpenAI,contactExcerpt} from '../tests/openai-fixture';
import {notifyInApp} from '../src/notifications';
import {ingestMessage} from '../src/mail';
const {env,close}=database();env.APP_URL='http://127.0.0.1:8789';env.OPENAI_API_KEY='fixture-only';env.ENABLE_AUTOMATION='false';env.ENABLE_SENDING='false';
globalThis.fetch=mockOpenAI().fetcher;
await run(env,'INSERT INTO settings(id,data) VALUES(1,?)',JSON.stringify({...testSettings,outreachPaused:process.argv.includes('--paused'),discoveryPaused:process.argv.includes('--paused')}));
const lead=await readyLead(env);const draft=await readyDraft(env,lead);
await run(env,"UPDATE drafts SET status='pending',approved_hash=NULL WHERE id=?",draft.id);
await run(env,"UPDATE leads SET contact_status='publicly_sourced',contact_evidence=?,status='review' WHERE id=?",JSON.stringify({sourceUrl:'https://pumps.example.com/contact',excerpt:contactExcerpt,status:'publicly_sourced'}),lead.id);
if(process.argv.includes('--notifications')){
 const followupLead=await readyLead(env,{company:'Follow-up demo',website:'https://followup.example.com',email:'team@followup.example.com'}),followup=await readyDraft(env,followupLead),due=new Date(Date.now()+4*86400000).toISOString();
 await run(env,"UPDATE leads SET status='contacted',last_sent_at=?,next_followup_at=? WHERE id=?",new Date().toISOString(),due,followupLead.id);await run(env,"UPDATE drafts SET kind='followup',status='pending',approved_hash=NULL,send_after=? WHERE id=?",due,followup.id);
 await notifyInApp(env,{key:'followup-demo',kind:'followup_ready',leadId:followupLead.id,draftId:followup.id,title:'Follow-up 1 ready for Follow-up demo',body:'Personalized follow-up ready for review. Nothing is sent without approval.'});
 const replyLead=await readyLead(env,{company:'Reply demo',website:'https://reply.example.com',email:'team@reply.example.com'}),sent=await readyDraft(env,replyLead);await run(env,"UPDATE drafts SET status='sent' WHERE id=?",sent.id);
 await ingestMessage(env,replyLead,{id:'fixture-reply',payload:{headers:[{name:'From',value:'team@reply.example.com'},{name:'Subject',value:'Could we discuss this product?'}],mimeType:'text/plain',body:{data:Buffer.from('Could we discuss how this product fits our business?').toString('base64url')}}});
}
env.ASSETS={fetch:async(request:Request)=>{const pathname=new URL(request.url).pathname;const p=path.resolve('public',pathname==='/'?'index.html':pathname.slice(1));if(!p.startsWith(path.resolve('public')+path.sep)||!fs.existsSync(p))return new Response('Not found',{status:404});return new Response(fs.readFileSync(p),{headers:{'Content-Type':p.endsWith('.html')?'text/html':p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':'application/octet-stream'}});}} as unknown as Fetcher;
const server=http.createServer(async(req,res)=>{
 try{const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const method=req.method||'GET';const headers=new Headers();for(const [key,value] of Object.entries(req.headers))if(value)headers.set(key,Array.isArray(value)?value.join(', '):value);
 const response=await worker.fetch(new Request(env.APP_URL+req.url,{method,headers,...(['GET','HEAD'].includes(method)?{}:{body:Buffer.concat(chunks)})}),env,{waitUntil:()=>{}} as unknown as ExecutionContext);
 res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
 }catch{res.writeHead(500);res.end('Fixture server failed');}
});
server.listen(8789,'127.0.0.1',()=>console.log('Isolated UI test server: http://127.0.0.1:8789; password: a-long-owner-password-for-tests-only; real sending disabled.'));
process.on('SIGTERM',()=>server.close(()=>{close();process.exit(0);}));process.on('SIGINT',()=>server.close(()=>{close();process.exit(0);}));
