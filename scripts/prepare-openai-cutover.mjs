import fs from 'node:fs';
import {query,wrangler} from './cloudflare.mjs';
import {readEnv} from './env.mjs';
const at=new Date().toISOString(),until=new Date(Date.now()+2*3600000).toISOString();
const claimed=query(`INSERT INTO leases(name,owner,expires_at) VALUES('scheduler','openai-migration','${until}') ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE leases.expires_at<'${at}' OR leases.owner='openai-migration';`);
if(!claimed[0].meta.changes)throw Error('A scheduler cycle is still active. Wait for it to finish before cutover.');
await import('./apply-daily-limits.mjs');
const e=readEnv(),o=e.APP_URL,h={Origin:o,'X-Requested-With':'Prepyr','Content-Type':'application/json'};
const login=await fetch(o+'/api/login',{method:'POST',headers:h,body:JSON.stringify({password:e.ADMIN_PASSWORD})});if(!login.ok)throw Error('Hosted login '+login.status);h.Cookie=login.headers.get('set-cookie').split(';')[0];
try{
 const active=query("SELECT id FROM runs WHERE state IN ('running','importing')")[0].results;
 if(active.length){const r=await fetch(o+'/api/discovery/sync',{method:'POST',headers:h,body:'{}'});if(!r.ok)throw Error('Existing provider reconciliation failed: '+r.status);}
 const d=await(await fetch(o+'/api/dashboard',{headers:h})).json();
 const exported=await(await fetch(o+'/api/export',{headers:h})).json();
 fs.writeFileSync('artifacts/openai-cutover-before.json',JSON.stringify({at,settings:d.settings,connections:d.connections,metrics:d.metrics,...exported},null,2),{mode:0o600});
 try{console.log(wrangler(['d1','export','DB','--remote','--output','artifacts/openai-cutover-before.sql']));}catch(error){if(!fs.existsSync('artifacts/openai-cutover-before.sql')||fs.statSync('artifacts/openai-cutover-before.sql').size<100)throw error;console.log('Database export file verified after CLI teardown.');}
 const reserve=query(`INSERT INTO expenses(id,provider,month,reserved,reference,note,created_at) SELECT 'openai-migration-benchmark','openai','${at.slice(0,7)}',2,'migration-benchmark','Capped isolated benchmark; reservation retained until results reconciled','${at}' WHERE NOT EXISTS(SELECT 1 FROM expenses WHERE id='openai-migration-benchmark') AND 2+COALESCE((SELECT SUM(CASE WHEN state='settled' THEN actual ELSE reserved END) FROM expenses WHERE provider='openai' AND month='${at.slice(0,7)}'),0)<=50;`);
 const reservation=query("SELECT reserved,state FROM expenses WHERE id='openai-migration-benchmark'")[0].results[0];
 if(!reservation||reservation.reserved!==2)throw Error('The shared benchmark reservation could not be verified');
 console.log(JSON.stringify({schedulerPaused:true,backup:true,benchmarkReservationCreated:reserve[0].meta.changes===1,counts:{leads:exported.leads.length,drafts:exported.drafts.length,messages:exported.messages.length,suppressions:exported.suppressions.length},remainingLegacyRuns:query("SELECT id,state FROM runs WHERE state IN ('running','importing','submitting','uncertain')")[0].results}));
}finally{await fetch(o+'/api/logout',{method:'POST',headers:h,body:'{}'});}
