import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import worker from '../src/index';
import {database,readyLead,readyDraft,testSettings} from '../tests/helpers';
import {run} from '../src/db';
import {mockOpenAI,contactExcerpt} from '../tests/openai-fixture';
const {env,close}=database();env.APP_URL='http://127.0.0.1:8789';env.OPENAI_API_KEY='fixture-only';env.ENABLE_AUTOMATION='false';env.ENABLE_SENDING='false';
globalThis.fetch=mockOpenAI().fetcher;
await run(env,'INSERT INTO settings(id,data) VALUES(1,?)',JSON.stringify(testSettings));
const lead=await readyLead(env);const draft=await readyDraft(env,lead);
await run(env,"UPDATE drafts SET status='pending',approved_hash=NULL WHERE id=?",draft.id);
await run(env,"UPDATE leads SET contact_status='publicly_sourced',contact_evidence=?,status='review' WHERE id=?",JSON.stringify({sourceUrl:'https://pumps.example.com/contact',excerpt:contactExcerpt,status:'publicly_sourced'}),lead.id);
env.ASSETS={fetch:async(request:Request)=>{const pathname=new URL(request.url).pathname;const p=path.resolve('public',pathname==='/'?'index.html':pathname.slice(1));if(!p.startsWith(path.resolve('public')+path.sep)||!fs.existsSync(p))return new Response('Not found',{status:404});return new Response(fs.readFileSync(p),{headers:{'Content-Type':p.endsWith('.html')?'text/html':p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':'application/octet-stream'}});}} as unknown as Fetcher;
const server=http.createServer(async(req,res)=>{
 try{const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const method=req.method||'GET';const headers=new Headers();for(const [key,value] of Object.entries(req.headers))if(value)headers.set(key,Array.isArray(value)?value.join(', '):value);
 const response=await worker.fetch(new Request(env.APP_URL+req.url,{method,headers,...(['GET','HEAD'].includes(method)?{}:{body:Buffer.concat(chunks)})}),env,{waitUntil:()=>{}} as unknown as ExecutionContext);
 res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
 }catch{res.writeHead(500);res.end('Fixture server failed');}
});
server.listen(8789,'127.0.0.1',()=>console.log('Isolated UI test server: http://127.0.0.1:8789; password: a-long-owner-password-for-tests-only; real sending disabled.'));
process.on('SIGTERM',()=>server.close(()=>{close();process.exit(0);}));process.on('SIGINT',()=>server.close(()=>{close();process.exit(0);}));
