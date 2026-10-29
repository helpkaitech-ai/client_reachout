import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { root,envPath,readEnv,updateEnv } from './env.mjs';
if(!fs.existsSync(envPath))fs.copyFileSync(path.join(root,'.env.example'),envPath);
const current=readEnv(),values={};
for(const key of ['ADMIN_PASSWORD','SESSION_SECRET'])if(!current[key])values[key]=randomBytes(32).toString('base64url');
updateEnv(values);
console.log('Ready: .env contains the workspace login and secret placeholders. Values were not printed.');
