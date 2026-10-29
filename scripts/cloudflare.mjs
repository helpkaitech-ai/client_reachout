import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {readEnv,root} from './env.mjs';
export function wrangler(args,input){
 const e=readEnv(),env={...process.env,WRANGLER_SEND_METRICS:'false'};
 for(const k of ['CLOUDFLARE_API_TOKEN','CLOUDFLARE_ACCOUNT_ID'])if(e[k])env[k]=e[k];
 const r=spawnSync(process.execPath,['--no-warnings',path.join(root,'node_modules/wrangler/wrangler-dist/cli.js'),...args],{cwd:root,env,input,encoding:'utf8',maxBuffer:32e6});
 if(r.error)throw r.error;
 if(r.status!==0){
  // Node 24 on Windows can assert during CLI teardown after a successful JSON
  // response. Accept only explicit successful query results, never API errors.
  let verified=false;try{const data=JSON.parse(r.stdout);verified=Array.isArray(data)&&data.length>0&&data.every(x=>x.success===true);}catch{}
  if(!verified)throw new Error(r.stdout||r.stderr||'Cloudflare command failed');
 }
 return r.stdout;
}
export function query(sql){return JSON.parse(wrangler(['d1','execute','DB','--remote','--json','--command',sql]));}
