import { readEnv,updateEnv,runtimeKeys } from './env.mjs';
import {wrangler as cloudflare} from './cloudflare.mjs';
await import('./generate-product-schema.mjs');
const e=readEnv();
if(!e.ADMIN_PASSWORD||!e.SESSION_SECRET)throw new Error('Run npm run setup before deploying');
function wrangler(args,input){const output=cloudflare(args,input);if(!input)console.log(output);return output;}
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
