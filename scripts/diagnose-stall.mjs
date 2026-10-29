import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {readEnv,root} from './env.mjs';

const e=readEnv(),env={...process.env,WRANGLER_SEND_METRICS:'false'};
for(const k of ['CLOUDFLARE_API_TOKEN','CLOUDFLARE_ACCOUNT_ID'])if(e[k])env[k]=e[k];
const sql=`
SELECT kind,state,error,COUNT(*) count,MIN(created_at) first_at,MAX(updated_at) last_at FROM jobs GROUP BY kind,state,error;
SELECT provider,month,state,COUNT(*) count,SUM(reserved) reserved,SUM(actual) actual FROM expenses GROUP BY provider,month,state;
SELECT day,research_slots,new_slots,send_slots FROM daily_usage ORDER BY day DESC LIMIT 8;
SELECT l.id,l.status,l.research_at,j.id job_id,j.state job_state,j.error,COUNT(d.id) drafts FROM leads l LEFT JOIN jobs j ON j.lead_id=l.id AND j.kind='research' LEFT JOIN drafts d ON d.lead_id=l.id WHERE NOT EXISTS(SELECT 1 FROM drafts WHERE lead_id=l.id) GROUP BY l.id,j.id;
SELECT type,COUNT(*) count,MIN(created_at) first_at,MAX(created_at) last_at FROM events GROUP BY type;
SELECT j.id,j.kind,j.state,j.updated_at,e.id expense_id,e.reference,e.state expense_state,e.reserved,e.actual,e.created_at FROM jobs j LEFT JOIN expenses e ON e.reference LIKE j.lead_id||':%' OR e.reference=j.lead_id WHERE j.state IN ('failed','uncertain') ORDER BY j.id,e.created_at;
SELECT name,expires_at FROM leases;
`;
const r=spawnSync(process.execPath,[path.join(root,'node_modules/wrangler/bin/wrangler.js'),'d1','execute','DB','--remote','--json','--command',sql],{cwd:root,env,encoding:'utf8',maxBuffer:4e6});
if(r.error)throw r.error;
if(r.status!==0){console.error(r.stderr||r.stdout);process.exit(r.status||1);}
const result=JSON.parse(r.stdout);
fs.writeFileSync(path.join(root,'artifacts/rca-database.json'),JSON.stringify({time:new Date().toISOString(),queries:sql,results:result},null,2));
console.log(JSON.stringify(result.map(x=>x.results),null,2));
