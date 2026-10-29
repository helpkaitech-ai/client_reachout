import { readEnv, updateEnv } from './env.mjs';
const e=readEnv();
const save=process.argv.includes('--save');
const seconds=Math.min(300,Math.max(1,Number(process.argv.find(a=>a.startsWith('--wait='))?.split('=')[1]||60)));
async function call(method,payload={}) {
 let response;
 try {response=await fetch(`https://api.telegram.org/bot${e.TELEGRAM_BOT_TOKEN}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(35000)});}
 catch {throw new Error('Telegram connection timed out. Check your internet connection and rerun this command.');}
 const data=await response.json();
 if(!response.ok||!data.ok){
  if(response.status===401)throw new Error('The bot token is invalid. Copy the current token from @BotFather into .env.');
  if(response.status===409)throw new Error('Another bot listener or webhook is active. Stop the other listener, then rerun this helper.');
  throw new Error(`Telegram request failed (HTTP ${response.status}). No token was printed.`);
 }
 return data.result;
}
async function main(){
 if(!e.TELEGRAM_BOT_TOKEN)throw new Error('Set TELEGRAM_BOT_TOKEN in .env first.');
 const bot=await call('getMe');
 console.log(`Connected bot: ${bot.first_name} (@${bot.username})`);
 console.log(`Open https://t.me/${bot.username} and send connect. A welcome reply is not required.`);
 if(e.TELEGRAM_CHAT_ID){
  const chat=await call('getChat',{chat_id:e.TELEGRAM_CHAT_ID});
  if(chat.type!=='private')throw new Error('The saved chat is not private. Check TELEGRAM_CHAT_ID.');
  console.log(`Your saved private chat is valid. TELEGRAM_CHAT_ID=${chat.id}`);return;
 }
 const webhook=await call('getWebhookInfo');
 if(webhook.url)throw new Error('This bot has an active webhook. This helper will not remove it; use a dedicated bot or deliberately remove that integration first.');
 const deadline=Date.now()+seconds*1000;
 console.log(`Listening for up to ${seconds} seconds. Do not run a second copy of this helper.`);
 while(Date.now()<deadline){
  // Explicitly enable message updates: Telegram otherwise reuses any previous update filter.
  const updates=await call('getUpdates',{timeout:Math.min(25,Math.max(0,Math.floor((deadline-Date.now())/1000))),allowed_updates:['message']});
  const chats=new Map();
  for(const update of updates||[]){const chat=update.message?.chat;if(chat?.type==='private')chats.set(String(chat.id),chat);}
  if(!chats.size)continue;
  for(const [id,chat] of chats)console.log(`Private chat: ${chat.first_name||'Telegram user'}; TELEGRAM_CHAT_ID=${id}`);
  if(save){
   if(chats.size!==1)throw new Error('Multiple private chats were found. Copy your own chat ID into .env; no ID was saved automatically.');
   const id=[...chats.keys()][0];await call('getChat',{chat_id:id});updateEnv({TELEGRAM_CHAT_ID:id});
   console.log('Saved TELEGRAM_CHAT_ID to .env. No messages sent and no activation switches changed.');
  }else console.log('Copy your chat ID into .env, or rerun with --save to save the single matching chat.');
  return;
 }
 console.log('Telegram returned no pending private messages. Send a NEW message to the exact bot link above and rerun. Older updates may have expired or been consumed by another listener.');
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
