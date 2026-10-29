import {wrangler} from './cloudflare.mjs';
const keys=JSON.parse(wrangler(['secret','list','--format','json']));
const retired=['APIFY_TOKEN','APIFY_ACTOR_ID','HUNTER_API_KEY'];
for(const name of retired)if(keys.some(k=>k.name===name)){
 wrangler(['secret','delete',name],'y\n');console.log('Removed obsolete Worker secret: '+name);
}
const after=JSON.parse(wrangler(['secret','list','--format','json']));
if(after.some(k=>retired.includes(k.name)))throw Error('An obsolete provider secret remains');
console.log('Verified obsolete provider secrets are absent; no account-wide tokens revoked.');
