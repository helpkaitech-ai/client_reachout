import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
import worker from '../src/index';
import {database,readyLead,readyDraft,testSettings} from './helpers';
import {attachBackup,snapshot,seedBackup} from './backup-helper';
import {backupStatus,importBackup,refreshBackup,savedWorkspace} from '../src/workspace-backup';
import {run} from '../src/db';
const base='https://outreach.example.com',quota="D1_ERROR: Your account has exceeded D1's free tier daily row read limit.";
const ctx={waitUntil:()=>{}} as unknown as ExecutionContext;
async function request(env:any,path:string,cookie?:string,payload?:any,origin=base){return worker.fetch(new Request(base+path,{method:payload===undefined?'GET':'POST',headers:{Origin:origin,'X-Requested-With':'Prepyr',...(cookie?{Cookie:cookie}:{})},...(payload===undefined?{}:{body:JSON.stringify(payload)})}),env,ctx);}
async function login(env:any){const r=await request(env,'/api/login',undefined,{password:env.ADMIN_PASSWORD});assert.equal(r.status,200);return r.headers.get('set-cookie')!.split(';')[0];}
function failD1(env:any){env.DB={prepare:()=>{throw new Error(quota);}};}
async function fixture(){
 const d=database(),backup=attachBackup(d.env);await run(d.env,'INSERT INTO settings(id,data) VALUES(1,?)',JSON.stringify(testSettings));
 const lead=await readyLead(d.env),draft=await readyDraft(d.env,lead);await run(d.env,"UPDATE drafts SET status='pending' WHERE id=?",draft.id);
 await run(d.env,"INSERT INTO messages(id,lead_id,direction,subject,body,classification,created_at) VALUES('reply',?,'inbound','Saved reply','The complete fetched reply body.','reply',?)",lead.id,new Date().toISOString());
 for(let i=0;i<60;i++)await run(d.env,'INSERT INTO leads(id,company,email,created_at,updated_at) VALUES(?,?,?,?,?)','page-'+i,'Saved company '+i,'team'+i+'@example.com',new Date().toISOString(),new Date().toISOString());
 const sentLead=await readyLead(d.env,{company:'Sent Business',website:'https://sent.example.com',email:'sent@example.com'}),sentDraft=await readyDraft(d.env,sentLead);
 await run(d.env,"UPDATE drafts SET status='sent',approved_hash=NULL WHERE id=?",sentDraft.id);await run(d.env,"UPDATE leads SET last_sent_at=?,status='contacted' WHERE id=?",new Date().toISOString(),sentLead.id);
 await seedBackup(d.env,d.sqlite);return {...d,backup,lead,draft,sentLead,sentDraft,close:()=>{backup.close();d.close();}};
}
test('saved workspace serves complete prospect pages, drafts, fetched emails, settings, metrics and previews during D1 quota failure',async()=>{
 const f=await fixture();try{
  const cookie=await login(f.env);failD1(f.env);
  const dashboard=await request(f.env,'/api/dashboard',cookie);assert.equal(dashboard.status,200);assert.equal(dashboard.headers.get('X-Relay-Data-Mode'),'saved-copy');const data=await dashboard.json() as any;
  assert.equal(data.availability.readOnly,true);assert.ok(data.availability.capturedAt);assert.equal(data.settings.businessAddress,testSettings.businessAddress);assert.equal(data.metrics.prospects,62);assert.equal(data.metrics.sent,1);
  const page=await(await request(f.env,'/api/prospects',cookie)).json() as any;assert.equal(page.rows.length,50);assert.equal(page.total,62);assert.equal(page.hasMore,true);
  const next=await(await request(f.env,'/api/prospects?offset=50',cookie)).json() as any;assert.equal(next.rows.length,12);assert.equal(new Set([...page.rows,...next.rows].map(r=>r.id)).size,62);
  const search=await(await request(f.env,'/api/prospects?q=Saved%20company%2059',cookie)).json() as any;assert.equal(search.total,1);assert.equal(search.rows[0].id,'page-59');
  const sent=await(await request(f.env,'/api/prospects?group=sent',cookie)).json() as any;assert.equal(sent.rows.length,1);assert.equal(sent.rows[0].draft_id,f.sentDraft.id);
  const detail=await(await request(f.env,'/api/prospects/'+f.lead.id,cookie)).json() as any;assert.equal(detail.drafts[0].body,f.draft.body);assert.equal(detail.messages[0].body,'The complete fetched reply body.');
  const preview=await(await request(f.env,'/api/drafts/'+f.draft.id+'/preview',cookie)).json() as any;assert.ok(preview.body.includes(f.draft.body));assert.ok(preview.body.includes(testSettings.businessAddress));
  const exported=await(await request(f.env,'/api/export',cookie)).json() as any;assert.equal(exported.leads.length,62);assert.equal(exported.drafts.length,2);assert.equal(exported.messages.length,1);assert.equal('sessions' in exported,false);
  for(const group of ['all','pending','sent','contacted','followup','replied','attention'])assert.equal((await request(f.env,'/api/prospects?group='+group,cookie)).status,200);
  f.backup.restart();assert.equal((await request(f.env,'/api/dashboard',cookie)).status,200);
 }finally{f.close();}
});
test('saved workspace remains authenticated and same-origin protected; outages cannot send, edit or overwrite settings',async()=>{
 const f=await fixture();try{
  const cookie=await login(f.env);failD1(f.env);
  for(const path of ['/api/dashboard','/api/prospects','/api/workspace-backup/status','/api/prospects/'+f.lead.id])assert.equal((await request(f.env,path)).status,401);
  assert.equal((await request(f.env,'/api/workspace-backup/import',cookie,{},'https://attacker.example')).status,403);
  for(const path of ['/api/settings/sender','/api/drafts/'+f.draft.id+'/approve','/api/drafts/'+f.draft.id+'/edit','/api/tick'])assert.equal((await request(f.env,path,cookie,{})).status,503);
  const copy=await savedWorkspace(f.env);assert.equal((await copy!.env.DB.prepare('SELECT businessAddress FROM settings').all().catch(()=>null)),null);
  await assert.rejects(()=>copy!.env.DB.prepare("DELETE FROM leads").all());await assert.rejects(()=>copy!.env.DB.prepare('SELECT 1').run());
  assert.equal((await request(f.env,'/api/logout',cookie,{})).status,200);assert.equal((await request(f.env,'/api/dashboard',cookie)).status,401);
 }finally{f.close();}
});
test('snapshot validation rejects authentication records, stale imports and invalid rows, keeping the active copy intact',async()=>{
 const f=await fixture();try{
  const before=await backupStatus(f.env);const secret=snapshot(f.sqlite);(secret.tables as any).sessions=[];await assert.rejects(()=>importBackup(f.env,secret));
  const duplicate=snapshot(f.sqlite);duplicate.tables.leads.push(duplicate.tables.leads[0]);await assert.rejects(()=>importBackup(f.env,duplicate));
  const stale=snapshot(f.sqlite,'2000-01-01T00:00:00.000Z');await assert.rejects(()=>importBackup(f.env,stale));
  const invalid=snapshot(f.sqlite);invalid.tables.drafts[0].kind='invalid-kind';await assert.rejects(()=>importBackup(f.env,invalid));
  assert.deepEqual(await backupStatus(f.env),before);assert.equal(f.backup.sqlite.prepare('SELECT COUNT(*) n FROM leads').get()!.n,62);
 }finally{f.close();}
});
test('unchanged checkpoints avoid rewriting records, update changed bodies, and do not replace a good copy on D1 failure',async()=>{
 const f=await fixture();try{
  assert.equal((await importBackup(f.env,snapshot(f.sqlite))).changed,0);
  await run(f.env,'UPDATE drafts SET body=? WHERE id=?','A newly saved draft body',f.draft.id);const updated=await importBackup(f.env,snapshot(f.sqlite));assert.equal(updated.changed,1);
  const before=await backupStatus(f.env);failD1(f.env);assert.equal((await refreshBackup(f.env,true)).updated,false);assert.deepEqual(await backupStatus(f.env),before);
  const cookie=await login(f.env);const detail=await(await request(f.env,'/api/prospects/'+f.lead.id,cookie)).json() as any;assert.equal(detail.drafts[0].body,'A newly saved draft body');
 }finally{f.close();}
});
test('automatic checkpoints save all workspace view tables and are throttled across requests',async()=>{
 const d=database(),backup=attachBackup(d.env);try{await readyLead(d.env);assert.equal((await refreshBackup(d.env)).updated,true);assert.equal((await refreshBackup(d.env)).updated,false);assert.equal((await backupStatus(d.env))!.counts.leads,1);}finally{backup.close();d.close();}
});
test('real UI and API can browse every screen and full emails, paginate, search and reload while D1 is down',async()=>{
 const f=await fixture(),dom=new JSDOM(fs.readFileSync('public/index.html','utf8'),{url:base,runScripts:'outside-only'}),doc=dom.window.document;let cookie='';const writes:string[]=[];
 (dom.window.HTMLDialogElement.prototype as any).showModal=function(){this.open=true;};(dom.window.HTMLDialogElement.prototype as any).close=function(){this.open=false;};
 const until=async(predicate:()=>boolean)=>{for(let i=0;i<200;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}throw new Error('UI failed: '+doc.querySelector('#toast')?.textContent);};
 const click=(selector:string)=>(doc.querySelector(selector) as HTMLElement).click();
 (dom.window as any).fetch=async(path:string,init:any)=>{if(init.method==='POST')writes.push(path);const r=await request(f.env,path,cookie,init.body?JSON.parse(init.body):undefined);const set=r.headers.get('set-cookie');if(set)cookie=set.split(';')[0];return r;};
 try{
  failD1(f.env);dom.window.eval(fs.readFileSync('public/app.js','utf8'));await new Promise(r=>setTimeout(r,50));(doc.querySelector('#password') as HTMLInputElement).value=f.env.ADMIN_PASSWORD!;click('#login-form button[type=submit]');
  await until(()=>!!doc.querySelector('tbody tr'));assert.equal((doc.querySelector('#login') as HTMLElement).hidden,true);assert.match(doc.querySelector('#content')!.textContent!,/Showing saved records/);assert.match(doc.querySelector('#live-status')!.textContent!,/Read only/);
  assert.equal(doc.querySelectorAll('tbody tr').length,50);click('[data-page="50"]');await until(()=>doc.querySelectorAll('tbody tr').length===12);
  const search=doc.querySelector('#search') as HTMLInputElement;search.value='Example Pumps';search.dispatchEvent(new dom.window.Event('input',{bubbles:true}));await until(()=>doc.querySelectorAll('tbody tr').length===1);
  click('[data-open]');await until(()=>!!doc.querySelector('#draft-form'));assert.equal((doc.querySelector('[name="body"]') as HTMLTextAreaElement).value,f.draft.body+'\n\nFree sample\n-----------\n'+f.draft.artifact);assert.equal((doc.querySelector('[name="body"]') as HTMLTextAreaElement).disabled,true);assert.equal(doc.querySelector('[data-send]'),null);
  assert.match(doc.querySelector('#modal-content')!.textContent!,/complete fetched reply body/);click('#close-modal');click('[data-view="dashboard"]');await until(()=>!!doc.querySelector('[data-group="sent"]'));
  assert.match(doc.querySelector('[data-group="sent"]')!.textContent!,/1/);click('[data-group="sent"]');await until(()=>!!doc.querySelector(`[data-email="${f.sentDraft.id}"]`));click(`[data-email="${f.sentDraft.id}"]`);await until(()=>!!doc.querySelector('#draft-form'));assert.match((doc.querySelector('[name="body"]') as HTMLTextAreaElement).value,/catalogue/);click('#close-modal');
  click('[data-view="settings"]');await until(()=>!!doc.querySelector('#sender-form'));assert.equal((doc.querySelector('[name="businessAddress"]') as HTMLInputElement).value,testSettings.businessAddress);assert.equal((doc.querySelector('#sender-form button[type=submit]') as HTMLButtonElement).disabled,true);
  click('#refresh');await new Promise(r=>setTimeout(r,80));assert.equal((doc.querySelector('#login') as HTMLElement).hidden,true);assert.ok(doc.querySelector('#sender-form'));assert.deepEqual(writes,['/api/login']);
  click('#logout');await until(()=>!(doc.querySelector('#login') as HTMLElement).hidden);
 }finally{dom.window.close();f.close();}
});
