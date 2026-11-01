import type {Env} from './types';
import {backupTables,backupSchema} from './workspace-schema';
export interface BackupInfo {capturedAt:string;savedAt:string;source:string;digest:string;counts:Record<string,number>}
interface Snapshot {capturedAt:string;source:string;tables:Record<string,Record<string,any>[]>}
export class WorkspaceBackup {
 private sql:SqlStorage;
 constructor(private state:DurableObjectState){
  this.sql=state.storage.sql;
  this.sql.exec('CREATE TABLE IF NOT EXISTS _backup_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  if(!this.meta('schema'))state.storage.transactionSync(()=>{this.sql.exec(backupSchema);this.set('schema',1);});
 }
 private meta<T=any>(key:string):T|null {const row=this.sql.exec<{value:string}>('SELECT value FROM _backup_meta WHERE key=?',key).toArray()[0];return row?JSON.parse(row.value):null;}
 private set(key:string,value:unknown){this.sql.exec('INSERT INTO _backup_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',key,JSON.stringify(value));}
 async fetch(request:Request):Promise<Response>{
  const path=new URL(request.url).pathname;
  if(path==='/status')return Response.json({snapshot:this.meta('snapshot')});
  if(path==='/claim'){
   const {force}=await request.json() as {force?:boolean};const time=Date.now(),last=this.meta<number>('lastAttempt')||0;
   const allowed=(force===true||time-last>=300000)&&time-(this.meta<number>('refreshStarted')||0)>=60000;
   if(allowed){this.set('lastAttempt',time);this.set('refreshStarted',time);}
   return Response.json({allowed});
  }
  if(path==='/query'){
   if(!this.meta('snapshot'))return Response.json({error:'No saved workspace'},{status:404});
   const {sql,args}=await request.json() as {sql:string;args:any[]};
   if(!/^(SELECT|WITH)\s/i.test(sql.trim())||sql.includes(';')||/\b(INSERT|UPDATE|DELETE|DROP|ALTER|PRAGMA|ATTACH|REPLACE)\b/i.test(sql))return Response.json({error:'Saved workspace is read only'},{status:403});
   return Response.json({rows:this.sql.exec(sql,...args).toArray()});
  }
  if(path==='/sync'){
   const input=await request.json() as Snapshot;
   if(!input||!Number.isFinite(Date.parse(input.capturedAt))||Date.parse(input.capturedAt)>Date.now()+300000||typeof input.source!=='string'||input.source.length>120||!input.tables)return Response.json({error:'Invalid workspace copy'},{status:400});
   if(Object.keys(input.tables).length!==backupTables.length||Object.keys(input.tables).some(t=>!backupTables.includes(t as any)))return Response.json({error:'Only workspace view tables may be saved'},{status:400});
   const counts:Record<string,number>={};
   // Validate everything before modifying the active copy.
   for(const table of backupTables){
    const rows=input.tables[table];if(!Array.isArray(rows)||rows.length>100000)return Response.json({error:'Invalid table rows'},{status:400});
    const columns=this.sql.exec<{name:string;pk:number}>(`PRAGMA table_info(${table})`).toArray(),names=new Set(columns.map(c=>c.name)),pk=columns.find(c=>c.pk)!.name,keys=new Set<string>();
    for(const row of rows){if(!row||typeof row!=='object'||Array.isArray(row)||row[pk]===undefined||keys.has(String(row[pk]))||Object.keys(row).some(k=>!names.has(k)||!(row[k]===null||typeof row[k]==='string'||typeof row[k]==='number')))return Response.json({error:'Invalid or duplicate workspace record'},{status:400});keys.add(String(row[pk]));}
    counts[table]=rows.length;
   }
   const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(input.tables))))).map(v=>v.toString(16).padStart(2,'0')).join('');
   let changed=0;
   try{this.state.storage.transactionSync(()=>{
    this.sql.exec('PRAGMA defer_foreign_keys=ON');
    const previous=this.meta<BackupInfo>('snapshot');if(previous&&Date.parse(previous.capturedAt)>Date.parse(input.capturedAt))throw new Error('An older copy cannot replace a newer one');
    for(const table of backupTables){
     const columns=this.sql.exec<{name:string;pk:number}>(`PRAGMA table_info(${table})`).toArray(),pk=columns.find(c=>c.pk)!.name;
     const old=new Map(this.sql.exec(`SELECT * FROM ${table}`).toArray().map(row=>[String(row[pk]),row]));
     for(const row of input.tables[table]){
      const key=String(row[pk]),existing=old.get(key);old.delete(key);const keys=Object.keys(row);
      if(existing&&keys.every(k=>existing[k]===row[k]))continue;
      const updates=keys.filter(k=>k!==pk).map(k=>`"${k}"=excluded."${k}"`).join(',');
      this.sql.exec(`INSERT INTO ${table}(${keys.map(k=>'"'+k+'"').join(',')}) VALUES(${keys.map(()=>'?').join(',')}) ON CONFLICT("${pk}") DO ${updates?'UPDATE SET '+updates:'NOTHING'}`,...keys.map(k=>row[k]));changed++;
     }
     for(const [key] of old){this.sql.exec(`DELETE FROM ${table} WHERE "${pk}"=?`,key);changed++;}
    }
    const orphans=this.sql.exec<{n:number}>('SELECT COUNT(*) n FROM drafts d LEFT JOIN leads l ON l.id=d.lead_id WHERE l.id IS NULL').toArray()[0].n;
    if(orphans)throw new Error('Workspace copy contains orphaned drafts');
    this.set('snapshot',{capturedAt:input.capturedAt,savedAt:new Date().toISOString(),source:input.source,digest,counts});
    this.set('lastAttempt',Date.now());this.set('refreshStarted',0);
   });}catch(e){return Response.json({error:e instanceof Error?e.message:'Workspace copy was not changed'},{status:409});}
   return Response.json({ok:true,snapshot:this.meta('snapshot'),changed});
  }
  return Response.json({error:'Not found'},{status:404});
 }
}
function stub(env:Env){if(!env.WORKSPACE_BACKUP)throw new Error('Workspace backup is not configured');return env.WORKSPACE_BACKUP.get(env.WORKSPACE_BACKUP.idFromName('workspace-v1'));}
async function call(env:Env,path:string,data?:unknown):Promise<any>{const r=await stub(env).fetch('https://workspace.internal'+path,{method:data===undefined?'GET':'POST',...(data===undefined?{}:{body:JSON.stringify(data)})});const value=await r.json() as any;if(!r.ok)throw new Error(value.error||'Saved workspace request failed');return value;}
export async function backupStatus(env:Env):Promise<BackupInfo|null>{if(!env.WORKSPACE_BACKUP)return null;return (await call(env,'/status')).snapshot;}
export async function forwardBackupImport(env:Env,request:Request):Promise<Response>{
 if(Number(request.headers.get('Content-Length')||0)>6000000)return Response.json({error:'Workspace copy is too large'},{status:413});
 let bytes=0;const limited=new TransformStream<Uint8Array,Uint8Array>({transform(chunk,controller){bytes+=chunk.byteLength;if(bytes>6000000)throw new Error('Workspace copy is too large');controller.enqueue(chunk);}});
 return stub(env).fetch('https://workspace.internal/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:request.body?.pipeThrough(limited)});
}
export async function importBackup(env:Env,input:unknown){return call(env,'/sync',input);}
export async function savedWorkspace(env:Env):Promise<{env:Env;info:BackupInfo}|null>{
 const info=await backupStatus(env);if(!info)return null;
 class Statement {
  constructor(private sql:string,private args:unknown[]=[]){ }
  bind(...args:unknown[]){return new Statement(this.sql,args);}
  async all(){return {results:(await call(env,'/query',{sql:this.sql,args:this.args})).rows,success:true,meta:{changes:0}};}
  async first(column?:string){const row=(await this.all()).results[0];return row?(column?row[column]:row):null;}
  async run(){throw new Error('Saved workspace is read only');}
 }
 const db={prepare:(sql:string)=>new Statement(sql),batch:()=>{throw new Error('Saved workspace is read only');}} as unknown as D1Database;
 return {env:{...env,DB:db,SAVED_WORKSPACE:true},info};
}
export async function refreshBackup(env:Env,force=false){
 if(!env.WORKSPACE_BACKUP)return {updated:false};
 try{
  if(!(await call(env,'/claim',{force})).allowed)return {updated:false};
  const capturedAt=new Date().toISOString(),tables:Record<string,unknown[]>={};
  await Promise.all(backupTables.map(async table=>{try{tables[table]=(await env.DB.prepare('SELECT * FROM '+table).all()).results;}catch(e){if(/no such table/i.test(e instanceof Error?e.message:''))tables[table]=[];else throw e;}}));
  const value=await importBackup(env,{capturedAt,source:'Automatic workspace checkpoint',tables});return {updated:true,...value};
 }catch{return {updated:false};}
}
export const isD1Unavailable=(e:unknown)=>{const message=e instanceof Error?e.message:'';return !/no such (?:table|column)|has no column named/i.test(message)&&/D1_ERROR|D1_EXEC_ERROR|D1 database.*(?:unavailable|overloaded)/i.test(message);};
