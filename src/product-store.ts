import type {Env} from './types';
import {productMigrations} from './product-schema';

// Binding-only endpoint: each product gets independent, transactionally durable
// SQLite storage. No user-provided product ID is interpolated into SQL.
export class ProductWorkspace {
 private sql:SqlStorage;
 constructor(private state:DurableObjectState){
  this.sql=state.storage.sql;
  this.sql.exec('CREATE TABLE IF NOT EXISTS _workspace_migrations(name TEXT PRIMARY KEY)');
  for(const m of productMigrations)if(!this.sql.exec('SELECT name FROM _workspace_migrations WHERE name=?',m.name).toArray().length)state.storage.transactionSync(()=>{this.sql.exec(m.sql);this.sql.exec('INSERT INTO _workspace_migrations VALUES(?)',m.name);});
  this.sql.exec('CREATE TABLE IF NOT EXISTS product_assets(id TEXT PRIMARY KEY,name TEXT NOT NULL,data TEXT NOT NULL)');
 }
 async fetch(request:Request){
  try{
   const input=await request.json() as {statements:{sql:string;args:unknown[]}[];batch?:boolean};
   if(!Array.isArray(input.statements)||input.statements.length>100)return Response.json({error:'Invalid workspace request'},{status:400});
   const execute=()=>input.statements.map(s=>{
    const c=this.sql.exec(s.sql,...s.args as any[]),rows=c.toArray();
    const changes=/^\s*(SELECT|PRAGMA|WITH)\b/i.test(s.sql)?0:Number(this.sql.exec<{n:number}>('SELECT changes() n').toArray()[0].n);
    return {results:rows,success:true,meta:{changes,rows_read:c.rowsRead,rows_written:c.rowsWritten}};
   });
   return Response.json(input.batch?this.state.storage.transactionSync(execute):execute());
  }catch(e){return Response.json({error:e instanceof Error?e.message:'Product database unavailable'},{status:500});}
 }
}
export function productDatabase(env:Env,id:string):D1Database {
 if(!env.PRODUCT_WORKSPACES)throw new Error('Product storage is not configured');
 const stub=env.PRODUCT_WORKSPACES.get(env.PRODUCT_WORKSPACES.idFromName(id));
 async function send(statements:Statement[],batch=false){
  const r=await stub.fetch('https://product.internal/sql',{method:'POST',body:JSON.stringify({statements:statements.map(s=>({sql:s.sql,args:s.args})),batch})});
  const data:any=await r.json();if(!r.ok)throw new Error('Product database: '+data.error);return data;
 }
 class Statement {
  constructor(public sql:string,public args:unknown[]=[]){ }
  bind(...args:unknown[]){return new Statement(this.sql,args);}
  async all(){return (await send([this]))[0];}
  async first(column?:string){const row=(await this.all()).results[0];return row?(column?row[column]:row):null;}
  async run(){return this.all();}
 }
 return {prepare:(sql:string)=>new Statement(sql),batch:(s:Statement[])=>send(s,true)} as unknown as D1Database;
}
