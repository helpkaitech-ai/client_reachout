import { DatabaseSync } from 'node:sqlite';
import { RelayAuthStore } from '../src/auth-store';
import {ProductWorkspace} from '../src/product-store';
import fs from 'node:fs';
import type { Env, Lead, Draft, Settings } from '../src/types';
import { defaults } from '../src/types';
import { importLead } from '../src/discovery';
import { approvalHash } from '../src/policy';
import { now, one, run } from '../src/db';
export function database(filename=':memory:') {
 const sqlite=new DatabaseSync(filename);
 if(!(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='leads'").get()))for(const file of fs.readdirSync('migrations').filter(f=>f.endsWith('.sql')).sort())sqlite.exec(fs.readFileSync('migrations/'+file,'utf8'));
 class Statement {
  constructor(public sql:string,public args:any[]=[]){ }
  bind(...args:any[]){return new Statement(this.sql,args);}
  async first(column?:string){const row=sqlite.prepare(this.sql).get(...this.args) as any;return row?(column?row[column]:{...row}):null;}
  async all(){const rows=sqlite.prepare(this.sql).all(...this.args).map(x=>({...x}));return {results:rows,success:true,meta:{changes:0}};}
  async run(){const result=sqlite.prepare(this.sql).run(...this.args);return {success:true,meta:{changes:Number(result.changes)}};}
 }
 const db={prepare:(sql:string)=>new Statement(sql),batch:async(statements:Statement[])=>{sqlite.exec('BEGIN');try{const results=[];for(const s of statements)results.push(await s.run());sqlite.exec('COMMIT');return results;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
 const authSqlite=new DatabaseSync(':memory:');
 const authState={storage:{sql:{exec:(sql:string,...args:any[])=>{const rows=authSqlite.prepare(sql).all(...args);return {toArray:()=>rows};}}}};
 const auth=new RelayAuthStore(authState as unknown as DurableObjectState);
 const authNamespace={idFromName:(name:string)=>name,get:()=>({fetch:(url:string,init:RequestInit)=>auth.fetch(new Request(url,init))})};
 const productStores=new Map<string,{sqlite:DatabaseSync;object:ProductWorkspace}>();
 const productNamespace={idFromName:(name:string)=>name,get:(id:string)=>{
  if(!productStores.has(id)){
   const sqlite=new DatabaseSync(':memory:');
   const state={storage:{transactionSync:(fn:()=>any)=>{sqlite.exec('BEGIN');try{const result=fn();sqlite.exec('COMMIT');return result;}catch(e){sqlite.exec('ROLLBACK');throw e;}},sql:{exec:(sql:string,...args:any[])=>{
    if(sql.includes(';')&&!args.length){sqlite.exec(sql);return {toArray:()=>[],rowsRead:0,rowsWritten:0};}
    const rows=sqlite.prepare(sql).all(...args);return {toArray:()=>rows,rowsRead:rows.length,rowsWritten:0};
   }}}};
   productStores.set(id,{sqlite,object:new ProductWorkspace(state as unknown as DurableObjectState)});
  }
  const object=productStores.get(id)!.object;return {fetch:(url:string,init:RequestInit)=>object.fetch(new Request(url,init))};
 }};
 const env:Env={AUTH_STORE:authNamespace as unknown as DurableObjectNamespace,DB:db as unknown as D1Database,ASSETS:{fetch:async()=>new Response('asset')} as unknown as Fetcher,ADMIN_PASSWORD:'a-long-owner-password-for-tests-only',SESSION_SECRET:'a-long-test-signing-secret-value',SENDER_EMAIL:'data@prepyr.com',APP_URL:'https://outreach.example.com'};
 env.PRODUCT_WORKSPACES=productNamespace as unknown as DurableObjectNamespace;
 return {env,sqlite,close:()=>{sqlite.close();authSqlite.close();for(const store of productStores.values())store.sqlite.close();}};
}
export async function readyLead(env:Env,overrides:Partial<Lead>={}) {
 const id=await importLead(env,{company:'Example Pumps',website:'https://pumps.example.com',email:'buyer@pumps.example.com',country:'US',timezone:'UTC',...overrides});
 await run(env,"UPDATE leads SET verification='manual',verification_note='Confirmed on official contact page today',eligibility='eligible',eligibility_note='Documented business outreach basis for test',research_at=? WHERE id=?",now(),id);
 return (await one<Lead>(env,'SELECT * FROM leads WHERE id=?',id))!;
}
export const testSettings:Settings={...defaults,sendStartHour:0,sendEndHour:24,sendWeekends:true,businessAddress:'Example business address, Example City',providerPolicyConfirmed:true};
export async function readyDraft(env:Env,lead:Lead,s=testSettings) {
 const d:Draft={id:crypto.randomUUID(),lead_id:lead.id,kind:'initial',subject:'A clearer pump quotation request',body:'Your catalogue lists connection sizes. A tailored quote form could carry the product details into each enquiry. Here is a free sample for your review.',artifact:'Sample fields: pump model, quantity, application.',evidence:JSON.stringify([{observation:'Product catalogue',url:'https://pumps.example.com/catalogue',kind:'observed',relevance:'Products'},{observation:'Enquiry page',url:'https://pumps.example.com/contact',kind:'observed',relevance:'Journey'}]),rationale:'Complete quote requests',warnings:'[]',status:'approved',version:1,approved_version:1,approved_hash:null,approved_at:now(),send_after:now(),provider_id:null,message_id:null,in_reply_to:null,inbound_id:null,error:null,created_at:now(),updated_at:now()};
 d.approved_hash=await approvalHash(d,lead,s,env.SENDER_EMAIL!);
 await run(env,`INSERT INTO drafts(id,lead_id,kind,subject,body,artifact,evidence,rationale,warnings,status,version,approved_version,approved_hash,approved_at,send_after,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,d.id,d.lead_id,d.kind,d.subject,d.body,d.artifact,d.evidence,d.rationale,d.warnings,d.status,d.version,d.approved_version,d.approved_hash,d.approved_at,d.send_after,d.created_at,d.updated_at);
 return d;
}
export function mockGoogle(send:(body:any)=>Response|Promise<Response>) {
 return async(url:any,init?:RequestInit)=>{
  const u=String(url);
  if(u.includes('oauth2.googleapis.com'))return Response.json({access_token:'test-token'});
  if(u.includes('settings/sendAs'))return Response.json({sendAs:[{sendAsEmail:'data@prepyr.com',verificationStatus:'accepted'}]});
  if(u.includes('messages/send'))return send(JSON.parse(String(init?.body)));
  if(u.includes('threads/'))return Response.json({messages:[]});
  if(u.includes('messages?'))return Response.json({messages:[]});
  throw new Error('Unexpected mocked provider URL');
 };
}
