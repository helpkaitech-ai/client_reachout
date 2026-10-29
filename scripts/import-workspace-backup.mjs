import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {readEnv,root} from './env.mjs';
const local=process.argv.includes('--local'),fixture=process.argv.includes('--fixture');
if(fixture&&!local)throw new Error('Fixture imports are restricted to the local test server');
const config=local?{APP_URL:'http://127.0.0.1:8791',ADMIN_PASSWORD:'local-auth-outage-fixture-only'}:readEnv();
const origin=new URL(config.APP_URL).origin;
const names=['settings','leads','drafts','messages','jobs','expenses','events','daily_usage','notifications','discovery_batches'];
const db=new DatabaseSync(':memory:');let capturedAt,source;
if(fixture){
 for(const file of fs.readdirSync(path.join(root,'migrations')).filter(f=>f.endsWith('.sql')).sort())db.exec(fs.readFileSync(path.join(root,'migrations',file),'utf8'));
 const at=new Date().toISOString();capturedAt=at;source='Local test fixture';
 db.prepare('INSERT INTO settings(id,data) VALUES(1,?)').run(JSON.stringify({senderName:'Fixture Owner',businessAddress:'Saved fixture address',locationIds:['country:IN']}));
 for(let i=0;i<65;i++)db.prepare('INSERT INTO leads(id,company,email,created_at,updated_at) VALUES(?,?,?,?,?)').run('fixture-'+i,'Saved Business '+String(i).padStart(3,'0'),'team'+i+'@example.com',at,at);
 db.prepare("INSERT INTO drafts(id,lead_id,kind,subject,body,status,created_at,updated_at) VALUES('draft-pending','fixture-0','initial','Saved introduction','The complete saved draft body.','pending',?,?)").run(at,at);
 db.prepare("INSERT INTO drafts(id,lead_id,kind,subject,body,status,created_at,updated_at) VALUES('draft-sent','fixture-1','initial','Saved sent email','The complete saved sent body.','sent',?,?)").run(at,at);
 db.prepare("UPDATE leads SET last_sent_at=?,status='contacted' WHERE id='fixture-1'").run(at);
 db.prepare("INSERT INTO messages(id,lead_id,direction,subject,body,classification,created_at) VALUES('received-1','fixture-1','inbound','Saved reply','The complete fetched reply body.','reply',?)").run(at);
}else{
 const file=path.join(root,'artifacts','relay-workspace-records.sql');
 db.exec(fs.readFileSync(file,'utf8'));capturedAt=fs.statSync(file).mtime.toISOString();source='Approved recovery export';
}
const tables={};for(const name of names){const exists=db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name);tables[name]=exists?db.prepare('SELECT * FROM '+name).all().map(row=>({...row})):[];}
db.close();
const expected=createHash('sha256').update(JSON.stringify(tables)).digest('hex');
let cookie='';
async function post(route,payload){const r=await fetch(origin+route,{method:'POST',headers:{Origin:origin,'X-Requested-With':'Prepyr','Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(payload)});if(!r.ok)throw new Error(route+' HTTP '+r.status+': '+(await r.text()).slice(0,250));return r;}
try{
 const signed=await post('/api/login',{password:config.ADMIN_PASSWORD});cookie=signed.headers.get('set-cookie').split(';')[0];
 const result=await(await post('/api/workspace-backup/import',{capturedAt,source,tables})).json();
 assert.equal(result.snapshot.digest,expected);for(const name of names)assert.equal(result.snapshot.counts[name],tables[name].length);
 const evidence={origin,capturedAt,digest:expected,counts:result.snapshot.counts,changed:result.changed};
 fs.writeFileSync(path.join(root,'artifacts',local?'workspace-local-import.json':'workspace-production-import.json'),JSON.stringify(evidence,null,2),{mode:0o600});
 console.log(JSON.stringify({verified:true,...evidence},null,2));
}finally{if(cookie)await post('/api/logout',{});}
