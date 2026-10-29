import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { root,readEnv,updateEnv,runtimeKeys } from './env.mjs';
await import('./generate-product-schema.mjs');
const e=readEnv();
if(!e.ADMIN_PASSWORD||!e.SESSION_SECRET)throw new Error('Run npm run setup before deploying');
const childEnv={...process.env,WRANGLER_SEND_METRICS:'false'};
for(const key of ['CLOUDFLARE_ACCOUNT_ID','CLOUDFLARE_API_TOKEN'])if(e[key])childEnv[key]=e[key];
function wrangler(args,input){const r=spawnSync(process.execPath,[path.join(root,'node_modules/wrangler/bin/wrangler.js'),...args],{cwd:root,env:childEnv,input,encoding:'utf8',maxBuffer:10*1024*1024});if(r.status!==0){console.error(r.stdout||'');console.error(r.stderr||r.error?.message||'Wrangler failed');process.exit(1);}if(!input)console.log(r.stdout);return r.stdout;}
wrangler(['d1','migrations','apply','DB','--remote']);
await import('./verify-schema.mjs');
const output=wrangler(['deploy']);
const url=output.match(/https:\/\/prepyr-outreach\.[a-z0-9-]+\.workers\.dev/)?.[0];
if(!e.APP_URL&&url){e.APP_URL=url;updateEnv({APP_URL:url});}
if(!e.APP_URL)throw new Error('Set APP_URL to the deployed URL, then run npm run deploy again');
const app=new URL(e.APP_URL);if(app.protocol!=='https:'||app.pathname!=='/'||app.search||app.hash)throw new Error('APP_URL must be an HTTPS origin, without path or query');
e.APP_URL=app.origin;
const secrets=Object.fromEntries(runtimeKeys.map(k=>[k,e[k]||'']));
wrangler(['secret','bulk'],JSON.stringify(secrets));
await import('./remove-retired-secrets.mjs');
console.log(`Deployment and secrets upload complete: ${e.APP_URL}`);
console.log('Credentials were sent directly to Cloudflare via stdin, not written to a temporary JSON file.');
console.log('Sign in with ADMIN_PASSWORD from .env. Review connection status and business settings.');
