import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
import {defaults} from '../src/types';

const until=async(fn:()=>boolean)=>{for(let i=0;i<200;i++){if(fn())return;await new Promise(r=>setTimeout(r,5));}throw Error('UI did not finish');};
const settle=()=>new Promise(r=>setTimeout(r,20));
function gate(){let release!:()=>void;const wait=new Promise<void>(r=>{release=r;});return {wait,release};}
async function boot(){
 const dom=new JSDOM(fs.readFileSync('public/index.html','utf8'),{url:'https://relay.example',runScripts:'outside-only'}),doc=dom.window.document;
 const lead={id:'lead',company:'Test studio',email:'studio@example.com',contact_name:'',eligibility:'eligible',verification:'manual'};
 const draft={id:'draft',lead_id:'lead',subject:'Your studio workflow',body:'A researched email for the studio.',artifact:'',status:'pending',version:1,evidence:'[]',warnings:'[]',sendIssues:[]};
 const dashboard={settings:{...defaults,outreachPaused:false,prospectingPaused:false,businessAddress:'Test address'},connections:{sendingEnabled:true,automationEnabled:true},budgets:[],jobs:[],events:[],expenses:[],runs:[]};
 const paths:string[]=[],controls={hold:(path:string)=>Promise.resolve(),fail:''};
 (dom.window.HTMLDialogElement.prototype as any).showModal=function(){this.open=true;};
 (dom.window.HTMLDialogElement.prototype as any).close=function(){this.open=false;this.dispatchEvent(new dom.window.Event('close'));};
 (dom.window as any).fetch=async(path:string,init:any)=>{
  paths.push(path);await controls.hold(path);if(path===controls.fail)return Response.json({error:'Temporary server failure'},{status:503});
  if(path==='/api/session')return Response.json({authenticated:true});
  if(path==='/api/products')return Response.json({products:[]});
  if(path==='/api/notifications')return Response.json({items:[],unread:0});
  if(path.startsWith('/api/dashboard?'))return Response.json(dashboard);
  if(path.startsWith('/api/prospects?'))return Response.json({rows:[{...lead,draft_id:draft.id,email_status:'pending'}],counts:{pending:1,sent:0},total:1,offset:0,hasMore:false});
  if(path==='/api/prospects/lead')return Response.json({lead,drafts:[draft],messages:[]});
  if(path.endsWith('/preview'))return Response.json({body:draft.body+'\nSender footer'});
  if(path==='/api/outreach/control'){dashboard.settings.outreachPaused=JSON.parse(init.body).paused;return Response.json({ok:true});}
  if(path.startsWith('/api/settings/'))return Response.json({ok:true});
  throw Error('Unexpected mocked request '+path);
 };
 dom.window.eval(fs.readFileSync('public/app.js','utf8'));await until(()=>!!doc.querySelector('[data-open]'));
 const click=(s:string)=>(doc.querySelector(s) as HTMLElement).click();
 return {dom,doc,paths,controls,click};
}

test('Settings opens synchronously without a prospect request, even when reads are delayed',async()=>{
 const {dom,doc,paths,controls,click}=await boot(),g=gate();try{
  controls.hold=()=>g.wait;const before=paths.length;click('[data-view="settings"]');
  assert.ok(doc.querySelector('#settings-form'));assert.equal(doc.querySelector('#breadcrumb')!.textContent,'Settings');assert.equal(paths.length,before);
 }finally{g.release();dom.window.close();}
});

test('pause acknowledges the click before the network responds, blocks duplicates, and recovers from failure',async()=>{
 const {dom,doc,paths,controls,click}=await boot(),g=gate();try{
  controls.hold=path=>path==='/api/outreach/control'?g.wait:Promise.resolve();controls.fail='/api/outreach/control';
  const b=doc.querySelector('#outreach-toggle') as HTMLButtonElement;click('#outreach-toggle');
  assert.equal(b.getAttribute('aria-busy'),'true');assert.equal(b.disabled,true);click('#outreach-toggle');assert.equal(paths.filter(p=>p==='/api/outreach/control').length,1);
  g.release();await until(()=>!b.disabled);assert.equal(b.hasAttribute('aria-busy'),false);assert.match(doc.querySelector('#toast')!.textContent!,/Temporary server failure/);
 }finally{g.release();dom.window.close();}
});

test('email opens an immediate loading dialog and a late response cannot reopen it after closing',async()=>{
 const {dom,doc,controls,click}=await boot(),g=gate();try{
  controls.hold=path=>path==='/api/prospects/lead'?g.wait:Promise.resolve();click('[data-open]');
  assert.equal((doc.querySelector('#modal') as HTMLDialogElement).open,true);assert.match(doc.querySelector('#modal-content')!.textContent!,/Loading email/);
  click('#close-modal');assert.equal((doc.querySelector('#modal') as HTMLDialogElement).open,false);g.release();await settle();assert.equal((doc.querySelector('#modal') as HTMLDialogElement).open,false);assert.equal(doc.querySelector('#draft-form'),null);
 }finally{g.release();dom.window.close();}
});

test('email failure replaces the loader with a recoverable error instead of an endless wait',async()=>{
 const {dom,doc,controls,click}=await boot();try{
  controls.fail='/api/prospects/lead';click('[data-open]');await until(()=>!!doc.querySelector('#modal-content [data-open]'));
  assert.match(doc.querySelector('#modal-content')!.textContent!,/Temporary server failure/);controls.fail='';click('#modal-content [data-open]');await until(()=>!!doc.querySelector('#draft-form'));
  assert.equal((doc.querySelector('[name="subject"]') as HTMLInputElement).value,'Your studio workflow');
 }finally{dom.window.close();}
});

test('page navigation responds immediately and a delayed list cannot overwrite a later Settings view',async()=>{
 const {dom,doc,controls,click}=await boot(),g=gate();try{
  controls.hold=path=>path.startsWith('/api/prospects?')?g.wait:Promise.resolve();click('[data-view="dashboard"]');
  assert.equal(doc.querySelector('#breadcrumb')!.textContent,'Dashboard');assert.match(doc.querySelector('#content')!.textContent!,/Loading prospects/);assert.equal(doc.querySelector('table'),null);
  click('[data-view="settings"]');assert.ok(doc.querySelector('#settings-form'));g.release();await settle();assert.ok(doc.querySelector('#settings-form'));assert.equal(doc.querySelector('#breadcrumb')!.textContent,'Settings');
 }finally{g.release();dom.window.close();}
});

test('independent reload reads run concurrently and duplicate refresh clicks do not create more requests',async()=>{
 const {dom,doc,paths,controls,click}=await boot(),g=gate(),dashboard=gate();try{
  controls.hold=path=>path==='/api/notifications'?g.wait:path.startsWith('/api/dashboard?')?dashboard.wait:Promise.resolve();
  const start=paths.length;click('#refresh');click('#refresh');assert.equal(doc.querySelector('#refresh')!.getAttribute('aria-busy'),'true');
  await until(()=>paths.slice(start).includes('/api/notifications'));
  assert.ok(paths.slice(start).includes('/api/products'),'product list must start while notifications are pending');
  g.release();await until(()=>paths.slice(start).some(p=>p.startsWith('/api/prospects?')));
  assert.equal(doc.querySelector('#refresh')!.getAttribute('aria-busy'),'true','list read starts before the dashboard completes');dashboard.release();await until(()=>doc.querySelector('#refresh')!.getAttribute('aria-busy')===null);
  assert.equal(paths.slice(start).filter(p=>p==='/api/session').length,1);
  assert.ok(paths.slice(start).some(p=>p.startsWith('/api/prospects?')));
 }finally{g.release();dashboard.release();dom.window.close();}
});

test('form submit shows immediate pending state and suppresses repeated submissions',async()=>{
 const {dom,doc,paths,controls,click}=await boot(),g=gate();try{
  click('[data-view="settings"]');const form=doc.querySelector('#sender-form') as HTMLFormElement,b=form.querySelector('button')!;
  controls.hold=path=>path==='/api/settings/sender'?g.wait:Promise.resolve();
  const submit=()=>form.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));submit();submit();
  assert.equal(b.getAttribute('aria-busy'),'true');assert.equal(b.disabled,true);assert.equal(paths.filter(p=>p==='/api/settings/sender').length,1);
  g.release();await until(()=>!doc.querySelector('#sender-form')!.hasAttribute('data-submitting'));assert.equal(doc.querySelector('#sender-form button')!.getAttribute('aria-busy'),null);
 }finally{g.release();dom.window.close();}
});
