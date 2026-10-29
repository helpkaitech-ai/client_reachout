import fs from 'node:fs';
import {readEnv} from './env.mjs';
const e=readEnv(),origin=e.APP_URL;
const r=await fetch(origin+'/api/login',{method:'POST',headers:{Origin:origin,'X-Requested-With':'Prepyr','Content-Type':'application/json'},body:JSON.stringify({password:e.ADMIN_PASSWORD})});
if(!r.ok)throw new Error('Browser login HTTP '+r.status);
const raw=r.headers.get('set-cookie').split(';')[0],index=raw.indexOf('=');
fs.writeFileSync('.browser-state.json',JSON.stringify({cookies:[{name:raw.slice(0,index),value:raw.slice(index+1),domain:new URL(origin).hostname,path:'/',httpOnly:true,secure:true,sameSite:'Strict',expires:-1}],origins:[]}),{mode:0o600});
console.log('Temporary browser authentication state prepared; no credentials printed.');
