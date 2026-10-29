// Authentication has its own SQLite Durable Object, independent of D1 quotas.
export class RelayAuthStore {
 private sql:SqlStorage;
 constructor(state:DurableObjectState) {
  this.sql=state.storage.sql;
  this.sql.exec('CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)');
  this.sql.exec('CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at)');
  this.sql.exec('CREATE TABLE IF NOT EXISTS attempts (key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, reset_at INTEGER NOT NULL)');
  this.sql.exec('CREATE INDEX IF NOT EXISTS attempts_expiry ON attempts(reset_at)');
 }
 async fetch(request:Request):Promise<Response> {
  const {key,expiresAt}=await request.json() as {key:string;expiresAt?:number};
  if(!/^[a-f0-9]{64}$/.test(key))return Response.json({error:'Invalid key'},{status:400});
  const time=Date.now(),path=new URL(request.url).pathname;
  // SQL operations after body parsing are synchronous, so concurrent attempts
  // cannot interleave the increment and its result.
  if(path==='/attempt') {
   this.sql.exec('DELETE FROM attempts WHERE reset_at<=?',time);
   const row=this.sql.exec<{attempts:number}>(`INSERT INTO attempts(key,attempts,reset_at) VALUES(?,1,?)
    ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN reset_at<=? THEN 1 ELSE attempts+1 END,
    reset_at=CASE WHEN reset_at<=? THEN excluded.reset_at ELSE reset_at END RETURNING attempts`,key,time+15*60000,time,time).toArray()[0];
   return Response.json({allowed:row.attempts<=8});
  }
  if(path==='/reset'){this.sql.exec('DELETE FROM attempts WHERE key=?',key);return Response.json({ok:true});}
  if(path==='/create') {
   if(!Number.isFinite(expiresAt)||expiresAt!<=time)return Response.json({error:'Invalid expiry'},{status:400});
   this.sql.exec('DELETE FROM sessions WHERE expires_at<=?',time);
   this.sql.exec('DELETE FROM attempts WHERE reset_at<=?',time);
   this.sql.exec('INSERT INTO sessions(token_hash,expires_at) VALUES(?,?)',key,expiresAt!);
   return Response.json({ok:true});
  }
  if(path==='/check')return Response.json({valid:this.sql.exec('SELECT token_hash FROM sessions WHERE token_hash=? AND expires_at>?',key,time).toArray().length===1});
  if(path==='/delete'){this.sql.exec('DELETE FROM sessions WHERE token_hash=?',key);return Response.json({ok:true});}
  return Response.json({error:'Not found'},{status:404});
 }
}
