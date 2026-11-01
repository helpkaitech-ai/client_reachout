import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {readEnv,root} from './env.mjs';
let useExistingLogin=false;
export function wrangler(args,input){
 const e=readEnv(),env={...process.env,WRANGLER_SEND_METRICS:'false'};
 for(const k of ['CLOUDFLARE_API_TOKEN','CLOUDFLARE_ACCOUNT_ID'])if(e[k])env[k]=e[k];
 if(useExistingLogin)delete env.CLOUDFLARE_API_TOKEN;
 const invoke=()=>spawnSync(process.execPath,['--no-warnings',path.join(root,'node_modules/wrangler/wrangler-dist/cli.js'),...args],{cwd:root,env,input,encoding:'utf8',maxBuffer:32e6});
 let r=invoke();
 // 7403 is an explicit authorization rejection: the operation did not run.
 // The configured account stays fixed; never retry ambiguous service failures.
 if(r.status!==0&&e.CLOUDFLARE_API_TOKEN&&/7403/.test((r.stdout||'')+'\n'+(r.stderr||''))){
  console.warn('Configured Cloudflare token rejected (7403); using the existing Wrangler login for the configured account.');
  useExistingLogin=true;delete env.CLOUDFLARE_API_TOKEN;r=invoke();
 }
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
