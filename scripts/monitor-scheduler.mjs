import fs from 'node:fs';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {root} from './env.mjs';

// Print only scheduled execution metadata, never HTTP request headers or logs.
const child=spawn(process.execPath,['--no-warnings',path.join(root,'node_modules/wrangler/wrangler-dist/cli.js'),'tail','--format','json'],{cwd:root,env:{...process.env,WRANGLER_SEND_METRICS:'false'},stdio:['ignore','pipe','pipe']});
const events=[];let buffer='',start=-1,depth=0,quoted=false,escaped=false;
child.stdout.on('data',chunk=>{
 for(const c of chunk.toString()){
  if(start<0){if(c!=='{')continue;start=0;buffer='';depth=0;quoted=false;escaped=false;}
  buffer+=c;
  if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;}
  else if(c==='"')quoted=true;else if(c==='{')depth++;else if(c==='}')depth--;
  if(depth===0){try{const value=JSON.parse(buffer);if(value.event?.cron){const item={at:value.eventTimestamp,outcome:value.outcome,cron:value.event.cron,cpuTime:value.cpuTime,wallTime:value.wallTime,exceptions:(value.exceptions||[]).map(x=>({name:x.name,message:x.message?.slice(0,300)}))};events.push(item);console.log(JSON.stringify(item));fs.writeFileSync(path.join(root,'artifacts/rca-scheduler-traces.json'),JSON.stringify(events,null,2));}}catch{}start=-1;buffer='';}
 }
});
child.stderr.on('data',()=>{});
child.on('error',error=>{console.error(error.code);process.exitCode=1;});
const timer=setTimeout(()=>child.kill('SIGTERM'),180000);
child.on('exit',code=>{clearTimeout(timer);console.log(JSON.stringify({scheduledEvents:events.length,exitCode:code}));});
