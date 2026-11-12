import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
export const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const envPath=path.join(root,'.env');
export function readEnv(){return fs.existsSync(envPath)?parseEnv(fs.readFileSync(envPath,'utf8')):{};}
export function updateEnv(values){let content=fs.readFileSync(envPath,'utf8');for(const [key,value] of Object.entries(values)){if(/[\r\n]/.test(value))throw new Error('Multiline secrets are not supported');const line=`${key}=${JSON.stringify(value)}`;const re=new RegExp('^'+key+'=.*$','m');content=re.test(content)?content.replace(re,()=>line):content+'\n'+line+'\n';}fs.writeFileSync(envPath,content,{mode:0o600});}
export const runtimeKeys=['ADMIN_PASSWORD','SESSION_SECRET','APP_URL','APIFY_TOKEN','OPENAI_API_KEY','OPENAI_RESEARCH_MODEL','OPENAI_DRAFT_MODEL','GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','GOOGLE_REFRESH_TOKEN','SENDER_EMAIL','NOTIFY_EMAIL','TELEGRAM_BOT_TOKEN','TELEGRAM_CHAT_ID','ENABLE_AUTOMATION','ENABLE_SENDING','ENABLE_NOTIFICATIONS'];
