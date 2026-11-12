import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
import worker from '../src/index';
import {database,readyLead,readyDraft,testSettings,mockGoogle} from './helpers';
import {run,one} from '../src/db';

test('actual UI to API to database sends an edited email and a follow-up, updating dashboard totals',async()=>{
 const {env,close}=database(),original=globalThis.fetch;Object.assign(env,{ENABLE_SENDING:'true',GOOGLE_CLIENT_ID:'test',GOOGLE_CLIENT_SECRET:'test',GOOGLE_REFRESH_TOKEN:'test'});
 const base='https://outreach.example.com',context={waitUntil:()=>{}} as unknown as ExecutionContext;let sends=0;const wireBodies:string[]=[];
 globalThis.fetch=mockGoogle((body:any)=>{sends++;wireBodies.push(Buffer.from(body.raw,'base64url').toString());return Response.json({id:'mail-'+sends,threadId:'thread'});}) as typeof fetch;
 const dom=new JSDOM(fs.readFileSync('public/index.html','utf8'),{url:base,runScripts:'outside-only'}),doc=dom.window.document;
 (dom.window.HTMLDialogElement.prototype as any).showModal=function(){this.open=true;};(dom.window.HTMLDialogElement.prototype as any).close=function(){this.open=false;};
 async function until(predicate:()=>boolean){for(let i=0;i<100;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}throw Error('UI did not reach expected state: '+doc.querySelector('#toast')?.textContent);}
 try{
  await run(env,'INSERT INTO settings(id,data) VALUES(1,?)',JSON.stringify({...testSettings,businessAddress:''}));const l=await readyLead(env),d=await readyDraft(env,l);await run(env,"UPDATE drafts SET status='pending' WHERE id=?",d.id);
  const signed=await worker.fetch(new Request(base+'/api/login',{method:'POST',headers:{Origin:base,'X-Requested-With':'Prepyr'},body:JSON.stringify({password:env.ADMIN_PASSWORD})}),env,context);const cookie=signed.headers.get('set-cookie')!.split(';')[0];
  (dom.window as any).fetch=(path:string,init:any)=>worker.fetch(new Request(base+path,{...init,headers:{...init.headers,Origin:base,Cookie:cookie}}),env,context);
  dom.window.eval(fs.readFileSync('public/app.js','utf8'));await until(()=>!!doc.querySelector('[data-open]'));
  (doc.querySelector('[data-view="settings"]') as HTMLElement).click();await until(()=>!!doc.querySelector('#sender-form'));
  assert.equal(doc.querySelector('[name="businessAddress"]'),null);
  (doc.querySelector('[data-view="prospects"]') as HTMLElement).click();await until(()=>!!doc.querySelector('[data-open]'));assert.doesNotMatch(doc.querySelector('#content')!.textContent!,/Add your postal address/);
  (doc.querySelector('[data-open]') as HTMLElement).click();await until(()=>!!doc.querySelector('[data-send]'));
  const edited='Your catalogue lists connection sizes. I can send a free pump quote checklist that captures flange dimensions and operating pressure.';(doc.querySelector('[name="body"]') as HTMLTextAreaElement).value=edited;
  const button=doc.querySelector('[data-send]') as HTMLButtonElement;button.click();button.click();await until(()=>!(doc.querySelector('#modal') as HTMLDialogElement).open);
  assert.equal(sends,1);assert.equal((await one<any>(env,'SELECT body FROM drafts WHERE id=?',d.id)).body,edited);assert.equal((await one<any>(env,'SELECT status FROM drafts WHERE id=?',d.id)).status,'sent');assert.match(doc.querySelector('#content')!.textContent!,/Sent/);
  const parts=[...wireBodies[0].matchAll(/Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)/g)].map(m=>Buffer.from(m[1],'base64').toString());
  assert.equal(parts.length,2);assert.match(parts[0],/free pump quote checklist/);assert.match(parts[1],/>Unsubscribe<\/a>/);assert.doesNotMatch(parts.join(''),/Business proposal|Example business address/);

  const followup=await readyDraft(env,l);await run(env,"UPDATE drafts SET status='pending',kind='followup' WHERE id=?",followup.id);await run(env,"UPDATE leads SET next_followup_at=? WHERE id=?",new Date(Date.now()-1000).toISOString(),l.id);
  (doc.querySelector('#refresh') as HTMLElement).click();await until(()=>!!doc.querySelector(`[data-email="${followup.id}"]`));(doc.querySelector(`[data-email="${followup.id}"]`) as HTMLElement).click();await until(()=>!!doc.querySelector(`[data-send="${followup.id}"]`));(doc.querySelector('[data-send]') as HTMLElement).click();await until(()=>!(doc.querySelector('#modal') as HTMLDialogElement).open);
  assert.equal(sends,2);assert.equal((await one<any>(env,'SELECT followup_count FROM leads WHERE id=?',l.id)).followup_count,1);
  (doc.querySelector('[data-view="dashboard"]') as HTMLElement).click();await until(()=>doc.querySelectorAll('.dashboard-details tbody tr').length===2);assert.match(doc.querySelector('[data-group="sent"]')!.textContent!,/2/);assert.match(doc.querySelector('[data-group="contacted"]')!.textContent!,/1/);assert.equal(doc.querySelectorAll('.dashboard-details tbody tr').length,2);
 }finally{dom.window.close();globalThis.fetch=original;close();}
});
