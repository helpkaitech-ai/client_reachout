import { readEnv } from './env.mjs';
const e=readEnv();
const groups={Login:['ADMIN_PASSWORD','SESSION_SECRET'],Research:['OPENAI_API_KEY'],Gmail:['GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','GOOGLE_REFRESH_TOKEN','SENDER_EMAIL'],Telegram:['TELEGRAM_BOT_TOKEN','TELEGRAM_CHAT_ID'],EmailUpdates:['NOTIFY_EMAIL']};
for(const [name,keys] of Object.entries(groups)){const missing=keys.filter(k=>!e[k]);console.log(`${name}: ${missing.length?'missing '+missing.join(', '):'configured (not live-verified)'}`);}
console.log(`Automation: ${e.ENABLE_AUTOMATION==='true'?'enabled':'paused'}; sending: ${e.ENABLE_SENDING==='true'?'enabled':'paused'}; notifications: ${e.ENABLE_NOTIFICATIONS==='true'?'enabled':'paused'}`);
console.log('Open the hosted Settings page to test connections. No keys or paid services are called by this command.');
