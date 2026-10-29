import {DatabaseSync} from 'node:sqlite';
import {WorkspaceBackup,importBackup} from '../src/workspace-backup';
import {backupTables} from '../src/workspace-schema';
import type {Env} from '../src/types';
export function attachBackup(env:Env){
 const sqlite=new DatabaseSync(':memory:');let writes=0;
 const sql={exec:(query:string,...args:any[])=>{
  if(!args.length&&query.includes(';')){sqlite.exec(query);return {toArray:()=>[]};}
  if(/^(INSERT|UPDATE|DELETE)/i.test(query))writes++;
  const rows=sqlite.prepare(query).all(...args).map(row=>({...row}));return {toArray:()=>rows};
 }};
 const state={storage:{sql,transactionSync:(fn:()=>unknown)=>{sqlite.exec('BEGIN');try{const result=fn();sqlite.exec('COMMIT');return result;}catch(e){sqlite.exec('ROLLBACK');throw e;}}}} as unknown as DurableObjectState;
 let store=new WorkspaceBackup(state);
 env.WORKSPACE_BACKUP={idFromName:(name:string)=>name,get:()=>({fetch:(url:string,init:RequestInit)=>store.fetch(new Request(url,init))})} as unknown as DurableObjectNamespace;
 return {sqlite,close:()=>sqlite.close(),restart:()=>{store=new WorkspaceBackup(state);},writes:()=>writes};
}
export function snapshot(sqlite:DatabaseSync,capturedAt=new Date().toISOString()){
 const tables:Record<string,any[]>={};for(const table of backupTables)tables[table]=sqlite.prepare('SELECT * FROM '+table).all().map(row=>({...row}));return {capturedAt,source:'Isolated test workspace',tables};
}
export async function seedBackup(env:Env,sqlite:DatabaseSync){return importBackup(env,snapshot(sqlite));}
