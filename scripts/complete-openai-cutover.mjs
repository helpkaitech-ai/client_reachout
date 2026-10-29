import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {readEnv,root} from './env.mjs';
import {query,wrangler} from './cloudflare.mjs';

const reportPath=path.join(root,'artifacts/openai-cutover-status.json');
const report={startedAt:new Date().toISOString(),status:'running',checks:[],openaiMonthlyCapUsd:50,prospectEmailsSentByValidation:0};
function save(){fs.writeFileSync(reportPath,JSON.stringify(report,null,2));}
function mark(check,extra={}){report.checks.push({check,at:new Date().toISOString(),...extra});save();console.log('PASS '+check);}
async function child(args){await new Promise((resolve,reject)=>{const p=spawn(process.execPath,args,{cwd:root,env:{...process.env,CI:'true',WRANGLER_SEND_METRICS:'false'},stdio:'inherit'});p.on('error',reject);p.on('exit',code=>code===0?resolve():reject(Error('Validation command exited '+code)));});}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function hosted(pathname,payload){const e=readEnv(),o=e.APP_URL,h={Origin:o,'X-Requested-With':'Prepyr','Content-Type':'application/json'};const login=await fetch(o+'/api/login',{method:'POST',headers:h,body:JSON.stringify({password:e.ADMIN_PASSWORD})});if(!login.ok)throw Error('Hosted login HTTP '+login.status);h.Cookie=login.headers.get('set-cookie').split(';')[0];try{const r=await fetch(o+pathname,{headers:h,...(payload?{method:'POST',body:JSON.stringify(payload)}:{})});if(!r.ok)throw Error('Hosted check HTTP '+r.status);return r.json();}finally{await fetch(o+'/api/logout',{method:'POST',headers:h,body:'{}'});}}
save();
try{
 if(new Date()<new Date('2026-10-29T00:05:00Z'))throw Error('Free-plan cutover is scheduled after the October 29 quota reset');
 await child(['node_modules/typescript/bin/tsc','--noEmit']);
 await child(['node_modules/tsx/dist/cli.mjs','--test',...fs.readdirSync(path.join(root,'tests')).filter(x=>x.endsWith('.test.ts')).map(x=>'tests/'+x)]);
 mark('typecheck and complete automated suite');
 let prepared=false;
 for(let attempt=0;attempt<25;attempt++){
  try{await child(['scripts/prepare-openai-cutover.mjs']);prepared=true;break;}catch(error){console.log('Waiting for cutover availability: '+error.message);if(attempt===24)throw error;await sleep(60000);}
 }
 if(!prepared)throw Error('Production backup/reservation could not be prepared');
 mark('scheduler paused, database backed up, $2 reserved inside shared cap');
 await child(['node_modules/tsx/dist/cli.mjs','scripts/benchmark-openai.ts','--reservation-confirmed']);
 const bench=JSON.parse(fs.readFileSync(path.join(root,'artifacts/openai-benchmark-results.json'),'utf8'));
 if(bench.inProgress||bench.unknownUsage)throw Error('Benchmark has an incomplete or uncertain paid outcome; original reservation retained');
 if(bench.committedUsd>2||bench.outboundMessages!==0)throw Error('Benchmark exceeded its boundaries');
 query(`UPDATE expenses SET actual=${Number(bench.committedUsd)},state='settled',note='Isolated OpenAI benchmark usage; retained local attempt evidence; invoice authoritative' WHERE id='openai-migration-benchmark';`);
 const qualified=bench.drafts.filter(d=>!d.quality_hold&&d.status==='pending'&&bench.businesses.some(l=>l.id===d.lead_id&&l.email&&l.contact_status==='publicly_sourced'));
 if(!qualified.length||!bench.businesses.some(l=>l.contact_status==='publicly_sourced')||!bench.searches.some(s=>s.imported>0))throw Error('Real-provider benchmark needs review: require a qualified draft, a sourced email and an imported independent business before deployment');
 mark('real OpenAI benchmark output and no-send boundaries',{committedUsd:bench.committedUsd,qualifiedDrafts:qualified.length});
 try{console.log(wrangler(['d1','migrations','apply','DB','--remote']));}catch(error){const applied=query("SELECT name FROM d1_migrations WHERE name='0006_openai_pipeline.sql'")[0].results;if(!applied.length)throw error;}
 query("UPDATE settings SET data=json_remove(json_set(data,'$.researchAutomation',json('false'),'$.openaiBudget',50,'$.discoveryResults',10,'$.dailyResearchLimit',20,'$.dailyNewLimit',12,'$.dailyTotalLimit',12),'$.apifyBudget','$.apifyRunCap','$.verificationBudget','$.verificationUnitCost') WHERE id=1;");
 const before=JSON.parse(fs.readFileSync(path.join(root,'artifacts/openai-cutover-before.json'),'utf8'));
 const count=query('SELECT (SELECT COUNT(*) FROM leads) leads,(SELECT COUNT(*) FROM drafts) drafts,(SELECT COUNT(*) FROM messages) messages,(SELECT COUNT(*) FROM suppressions) suppressions;')[0].results[0];
 for(const key of ['leads','drafts','messages','suppressions'])if(count[key]!==before[key].length)throw Error('Preservation count changed for '+key);
 mark('additive migration and production record counts preserved',count);
 const output=wrangler(['deploy']);console.log(output);report.codeVersion=output.match(/Current Version ID:\s*([a-f0-9-]+)/)?.[1];save();
 await child(['scripts/remove-retired-secrets.mjs']);mark('OpenAI-only code deployed and obsolete Worker secrets absent');
 await child(['scripts/smoke-hosted.mjs']);mark('hosted authentication, UI/API and sender checks');
 const after=await hosted('/api/export');
 for(const key of ['drafts','messages','suppressions'])for(const original of before[key]){
  const identity=key==='suppressions'?'email':'id',saved=after[key].find(x=>x[identity]===original[identity]);
  if(!saved)throw Error('Missing preserved record: '+key);
  for(const field of Object.keys(original))if(saved[field]!==original[field])throw Error(`Preserved ${key} record changed at ${field}`);
 }
 mark('all existing draft edits, approvals, sent messages and suppressions unchanged');
 query("UPDATE settings SET data=json_set(data,'$.researchAutomation',json('true')) WHERE id=1; DELETE FROM leases WHERE name='scheduler' AND owner='openai-migration';");
 const resumedAt=new Date().toISOString();
 let progressed=false;
 for(let cycle=0;cycle<25;cycle++){
  await sleep(60000);const d=await hosted('/api/dashboard');
  const progress=query(`SELECT (SELECT COUNT(*) FROM ai_attempts WHERE state='complete') completed,(SELECT COUNT(*) FROM drafts d JOIN leads l ON l.id=d.lead_id WHERE d.created_at>'${resumedAt}' AND COALESCE(d.quality_hold,'')='' AND l.contact_status='publicly_sourced') new_drafts;`)[0].results[0];
  if(progress.new_drafts>0&&progress.completed>0){progressed=true;report.finalMetrics=d.metrics;report.pipeline=d.pipeline;break;}
 }
 if(!progressed)throw Error('Deployment is live, but automatic draft progress needs further investigation');
 mark('automatic production research produced new drafts');
 report.status='complete';report.completedAt=new Date().toISOString();save();console.log('COMPLETE: OpenAI-only Relay migration and validation passed.');
}catch(error){report.status='needs_attention';report.error=error.message;report.finishedAt=new Date().toISOString();save();console.error(error.message);process.exitCode=1;
 // Never replay unknown requests or automatically restore removed providers.
 try{query("DELETE FROM leases WHERE name='scheduler' AND owner='openai-migration';");}catch{}
}
