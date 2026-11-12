import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
import {defaults} from '../src/types';
import {locationOptions} from '../src/locations';
const html=fs.readFileSync('public/index.html','utf8'),code=fs.readFileSync('public/app.js','utf8');
const flush=()=>new Promise(r=>setTimeout(r,40));
async function boot(options:{blocked?:boolean;anonymous?:boolean;failSend?:boolean;databaseLimit?:boolean;loginFirst?:boolean;discoveryPausedUntil?:string;outreachPaused?:boolean;discoveryPaused?:boolean}={}){
 const lead={id:'l1',company:'Pump Specialists',email:'team@pumps.example',city:'Leeds',country:'GB',status:'review',verification:'valid',eligibility:'pending',verification_note:'Previously checked address',eligibility_note:'',timezone:'Europe/London',contact_name:'Jane',contact_evidence:JSON.stringify({profileUrl:'https://www.linkedin.com/in/jane-fixture/'}),last_sent_at:null,next_followup_at:null,followup_count:0};
 const draft={id:'d1',lead_id:'l1',company:lead.company,subject:'A pump enquiry example',body:'Your catalogue lists pressure ratings. Prepyr could help review one table of pump specifications.',artifact:'',evidence:'[]',warnings:'[]',rationale:'Collect pump pressure details',version:1,status:'pending',kind:'initial',sendIssues:[]};
 const data={locationOptions,settings:{...defaults,outreachPaused:!!options.outreachPaused,discoveryPaused:!!options.discoveryPaused,discoveryPausedUntil:options.discoveryPausedUntil||'',businessAddress:options.blocked?'':'A test business address'},connections:{sendingEnabled:!options.blocked,automationEnabled:true},budgets:[],drafts:[draft],leads:[lead],messages:[],jobs:[],events:[],runs:[],notifications:[],expenses:[]};
 const requests:any[]=[],dom=new JSDOM(html,{url:'https://outreach.example.com',runScripts:'outside-only'}),doc=dom.window.document;
 (dom.window.HTMLDialogElement.prototype as any).showModal=function(){this.open=true;};(dom.window.HTMLDialogElement.prototype as any).close=function(){this.open=false;};
 let signedIn=!options.loginFirst;
 (dom.window as any).fetch=async(path:string,init:any)=>{requests.push({path,body:init.body?JSON.parse(init.body):undefined});if(path==='/api/login'){signedIn=true;return Response.json({ok:true});}if(path==='/api/logout'){signedIn=false;return Response.json({ok:true});}if(options.anonymous||!signedIn)return Response.json({error:'Sign in to continue'},{status:401});
  if(path==='/api/session')return Response.json({authenticated:true});
  if(path==='/api/outreach/control'){data.settings.outreachPaused=JSON.parse(init.body).paused;return Response.json({ok:true});}
  if(path==='/api/discovery/control'){data.settings.discoveryPaused=JSON.parse(init.body).paused;return Response.json({ok:true});}
  if(options.databaseLimit)return Response.json({error:'You are signed in. Workspace data is temporarily unavailable. Database daily limit resets at 05:30 IST (00:00 UTC).',code:'DATABASE_DAILY_LIMIT'},{status:503});
  if(path==='/api/prospects/l1')return Response.json({lead,drafts:[draft],messages:[]});
  if(path.startsWith('/api/prospects?'))return Response.json({rows:[{...lead,draft_id:'d1',email_status:draft.status==='sent'?'sent':'pending'}],counts:{sent:draft.status==='sent'?1:0,pending:1,contacted:0,followup:0,replied:0,attention:0},total:1,offset:0,hasMore:false});
  if(path.endsWith('/preview'))return Response.json({message:draft.body+'\n\nRushi',body:draft.body+'\n\nRushi',senderName:'Rushi',product:{name:'Prepyr',website:'https://prepyr.com/'},unsubscribeUrl:'https://outreach.example.com/unsubscribe?id=l1'});
  if(path.endsWith('/edit')){const b=JSON.parse(init.body);Object.assign(draft,{subject:b.subject,body:b.body,artifact:b.artifact,version:draft.version+1});return Response.json({ok:true});}
  if(path.endsWith('/approve')){if(options.failSend)return Response.json({error:'Draft changed. Refresh and try again.'},{status:400});draft.status='sent';return Response.json({status:'sent',message:'Sent through Gmail.'});}
  if(path.startsWith('/api/settings/')){data.settings={...data.settings,...JSON.parse(init.body)};return Response.json({ok:true,settings:data.settings,connections:data.connections});}
  return Response.json(data);
 };
 dom.window.eval(fs.readFileSync('public/theme.js','utf8'));dom.window.eval(code);await flush();const click=async(s:string)=>{(doc.querySelector(s) as HTMLElement).click();await flush();};return {dom,doc,requests,click,draft};
}
test('opens on Prospects with product research navigation, plain statuses and no Needs attention filter',async()=>{const {dom,doc}=await boot();try{assert.deepEqual([...doc.querySelectorAll('[data-view]')].map(x=>(x as HTMLElement).dataset.view),['products','prospects','dashboard','settings']);assert.equal(doc.querySelector('#breadcrumb')?.textContent,'Prospects');assert.match(doc.querySelector('#content')!.textContent!,/Pending send/);assert.doesNotMatch(doc.querySelector('#content')!.textContent!,/initial draft|Discovery & drafting|Review queue/);assert.equal(doc.querySelector('#status-filter option[value="attention"]'),null);assert.ok(doc.querySelector('[name="searchTarget"]'));assert.equal(doc.querySelector('#live-status'),null);}finally{dom.window.close();}});

test('legacy flags show no pause controls and only an explicit click requests a search',async()=>{const {dom,doc,click,requests}=await boot({outreachPaused:true,discoveryPaused:true});try{assert.equal(doc.querySelector('#outreach-state'),null);assert.equal(doc.querySelector('#outreach-toggle'),null);assert.equal(doc.querySelector('[data-discovery-control]'),null);assert.equal((doc.querySelector('[data-action="discover"]') as HTMLButtonElement).disabled,false);assert.equal(requests.filter(r=>r.path==='/api/discover').length,0);await click('[data-action="discover"]');assert.equal(requests.filter(r=>r.path==='/api/discover').length,1);}finally{dom.window.close();}});

test('retired timed holds do not block Find prospects',async()=>{const {dom,doc,requests,click}=await boot({discoveryPausedUntil:new Date(Date.now()+3*86400000).toISOString()});try{assert.ok(doc.querySelector('[name="searchTarget"]'));assert.equal((doc.querySelector('[data-action="discover"]') as HTMLButtonElement).disabled,false);await click('[data-action="discover"]');assert.equal(requests.some(r=>r.path==='/api/discover'),true);await click('[data-open="l1"]');assert.equal(doc.querySelector('#modal')!.hasAttribute('open'),true);}finally{dom.window.close();}});
test('dashboard cards load matching details underneath on the same page',async()=>{const {dom,doc,requests,click}=await boot();try{await click('[data-view="dashboard"]');await click('[data-group="contacted"]');assert.equal(doc.querySelector('#breadcrumb')?.textContent,'Dashboard');assert.equal(doc.querySelector('.dashboard-details h2')?.textContent,'Businesses contacted');assert.ok(requests.some(r=>r.path.includes('group=contacted')));assert.equal(doc.querySelector('[data-group="contacted"]')?.getAttribute('aria-pressed'),'true');}finally{dom.window.close();}});
test('settings show appearance and collapse sender details without requiring an address',async()=>{const {dom,doc,requests,click}=await boot();try{await click('[data-view="settings"]');assert.equal(doc.querySelector('[name="businessAddress"]'),null);assert.ok(doc.querySelector('#theme-preference'));const name=doc.querySelector('[name="senderName"]') as HTMLInputElement;name.value='New sender';(doc.querySelector('#sender-form button[type=submit]') as HTMLButtonElement).click();await flush();assert.equal(requests.find(r=>r.path==='/api/settings/sender').body.senderName,'New sender');assert.equal(doc.querySelectorAll('details[open]').length,0);}finally{dom.window.close();}});

test('single Send saves edited content, sends once, closes email and updates status',async()=>{const {dom,doc,requests,click}=await boot();try{await click('[data-open]');assert.equal(doc.querySelector('[name="artifact"]'),null);assert.equal(doc.querySelector('#evidence-reviewed'),null);assert.equal(doc.querySelectorAll('.simple-review details[open]').length,0);(doc.querySelector('[name="body"]') as HTMLTextAreaElement).value='Your pump catalogue lists pressure ratings. Here is a free checklist tailored to that pump range.';const send=doc.querySelector('[data-send]') as HTMLButtonElement;send.click();send.click();await flush();const writes=requests.filter(r=>r.path.endsWith('/edit')||r.path.endsWith('/approve'));assert.equal(writes.length,2);assert.ok(writes[0].path.endsWith('/edit'));assert.equal(writes[1].body.version,2);assert.equal(writes[1].body.evidenceReviewed,true);assert.equal(writes[1].body.contactReviewed,true);assert.equal((doc.querySelector('#modal') as HTMLDialogElement).open,false);assert.match(doc.querySelector('#content')!.textContent!,/Sent/);}finally{dom.window.close();}});
test('sender blocker disables Send and never calls sending API',async()=>{const {dom,doc,requests,click}=await boot({blocked:true});try{await click('[data-open]');const button=doc.querySelector('[data-send]') as HTMLButtonElement;assert.equal(button.disabled,true);button.click();await flush();assert.equal(requests.filter(r=>r.path.endsWith('/approve')).length,0);}finally{dom.window.close();}});
test('sending error preserves editor and does not falsely mark sent',async()=>{const {dom,doc,requests,click}=await boot({failSend:true});try{await click('[data-open]');await click('[data-send]');assert.equal((doc.querySelector('#modal') as HTMLDialogElement).open,true);assert.match(doc.querySelector('#toast')!.textContent!,/Draft changed/);assert.equal(requests.filter(r=>r.path.endsWith('/approve')).length,1);}finally{dom.window.close();}});
test('unauthenticated request reveals no prospect table',async()=>{const {dom,doc}=await boot({anonymous:true});try{assert.equal(doc.querySelector('#login')?.hasAttribute('hidden'),false);assert.equal(doc.querySelector('#app')?.hasAttribute('hidden'),true);}finally{dom.window.close();}});

test('country-first dropdowns save country-wide or city scopes, clear stale cities, and close on outside interaction',async()=>{
 const {dom,doc,requests,click}=await boot();
 const change=(id:string,value:string)=>{const field=doc.querySelector(id) as unknown as HTMLSelectElement;field.value=value;field.dispatchEvent(new dom.window.Event('change',{bubbles:true}));};
 try{
  assert.equal((doc.querySelector('#place-filter') as unknown as HTMLSelectElement).disabled,true);
  change('#country-filter','country:IN');assert.equal((doc.querySelector('#place-filter') as unknown as HTMLSelectElement).disabled,false);
  assert.ok(doc.querySelector('#place-filter option[value="city:mumbai"]'));assert.equal(doc.querySelector('#place-filter option[value="city:london"]'),null);
  await click('[data-action="discover"]');assert.deepEqual(requests.find(r=>r.path==='/api/settings/locations').body.locationIds,['country:IN']);
  change('#place-filter','city:mumbai');await click('[data-action="discover"]');assert.deepEqual(requests.filter(r=>r.path==='/api/settings/locations').at(-1).body.locationIds,['city:mumbai']);
  await click('[data-view="settings"]');assert.equal((doc.querySelector('#country-filter') as unknown as HTMLSelectElement).value,'country:IN');assert.equal((doc.querySelector('#place-filter') as unknown as HTMLSelectElement).value,'city:mumbai');
  change('#country-filter','country:US');assert.equal((doc.querySelector('#place-filter') as unknown as HTMLSelectElement).value,'');assert.equal(doc.querySelector('#place-filter option[value="city:mumbai"]'),null);
  const country=doc.querySelector('#country-filter') as unknown as HTMLSelectElement;country.focus();doc.body.dispatchEvent(new dom.window.Event('pointerdown',{bubbles:true}));assert.notEqual(doc.activeElement,country);
  change('#country-filter','');assert.equal((doc.querySelector('#place-filter') as unknown as HTMLSelectElement).disabled,true);
 }finally{dom.window.close();}
});

test('profile column follows the prospect and links the sourced LinkedIn page',async()=>{
 const {dom,doc}=await boot();try{assert.deepEqual([...doc.querySelectorAll('th')].slice(0,3).map(x=>x.textContent),['Prospect','Profile','Email']);const link=doc.querySelector('.profile-cell a')!;assert.equal(link.getAttribute('href'),'https://www.linkedin.com/in/jane-fixture/');assert.match(link.textContent!,/LinkedIn/);assert.equal(link.getAttribute('rel'),'noopener noreferrer');}finally{dom.window.close();}
});

for(const loginFirst of [false,true])test(`D1 limit keeps workspace open after ${loginFirst?'password login':'session reload'} and allows sign out`,async()=>{
 const {dom,doc,requests,click}=await boot({databaseLimit:true,loginFirst});
 try{
  if(loginFirst){(doc.querySelector('#password') as HTMLInputElement).value='fixture-password';await click('#login-form button[type=submit]');}
  assert.equal((doc.querySelector('#login') as HTMLElement).hidden,true);assert.equal((doc.querySelector('#app') as HTMLElement).hidden,false);
  assert.match(doc.querySelector('#content')!.textContent!,/temporarily unavailable/);assert.match(doc.querySelector('#content')!.textContent!,/05:30 IST/);
  assert.equal(doc.querySelector('#login-error')!.textContent,'');assert.equal(doc.querySelector('table'),null);
  await click('[data-reload]');await click('[data-view="settings"]');assert.equal((doc.querySelector('#login') as HTMLElement).hidden,true);
  assert.ok(requests.filter(r=>r.path==='/api/session').length>=3);await click('#logout');assert.equal((doc.querySelector('#login') as HTMLElement).hidden,false);
 }finally{dom.window.close();}
});


test('dark mode stays synchronized between header and Settings and persists on reload',async()=>{
 const {dom,doc,click}=await boot();try{
  assert.equal(doc.documentElement.dataset.theme,'light');await click('#theme-toggle');assert.equal(doc.documentElement.dataset.theme,'dark');assert.equal(dom.window.localStorage.getItem('relay-theme'),'dark');
  await click('[data-view="settings"]');const select=doc.querySelector('#theme-preference') as unknown as unknown as HTMLSelectElement;assert.equal(select.value,'dark');select.value='light';select.dispatchEvent(new dom.window.Event('change',{bubbles:true}));assert.equal(doc.documentElement.dataset.theme,'light');assert.equal(doc.querySelector('#theme-toggle')!.getAttribute('aria-pressed'),'false');
  dom.window.localStorage.setItem('relay-theme','dark');dom.window.eval(fs.readFileSync('public/theme.js','utf8'));assert.equal(doc.documentElement.dataset.theme,'dark');assert.equal(select.value,'dark');
 }finally{dom.window.close();}
});

test('search sends the entered per-search cap and rejects invalid counts before any request',async()=>{
 const {dom,doc,click,requests}=await boot();try{
  const field=doc.querySelector('[name="searchTarget"]') as HTMLInputElement;field.value='25';field.dispatchEvent(new dom.window.Event('input',{bubbles:true}));await click('[data-action="discover"]');assert.equal(requests.find(r=>r.path==='/api/discover').body.target,25);
  const fresh=doc.querySelector('[name="searchTarget"]') as HTMLInputElement;fresh.value='0';fresh.dispatchEvent(new dom.window.Event('input',{bubbles:true}));await click('[data-action="discover"]');assert.equal(requests.filter(r=>r.path==='/api/discover').length,1);
 }finally{dom.window.close();}
});


test('opening a saved email immediately shows clickable product mentions and edits update that visible message',async()=>{
 const {dom,doc,click,requests}=await boot();try{
  await click('[data-open]');const preview=doc.querySelector('#email-preview')!;
  assert.equal(preview.closest('details'),null);assert.equal(preview.querySelector('iframe'),null);
  const product=preview.querySelector('a[href="https://prepyr.com/"]')!;assert.equal(product.textContent,'Prepyr');assert.equal(product.getAttribute('target'),'_blank');assert.equal(product.getAttribute('rel'),'noopener noreferrer');
  assert.equal(doc.querySelector('.email-editor')!.hasAttribute('open'),false);
  const body=doc.querySelector('[name="body"]') as HTMLTextAreaElement;body.value='Prepyr & <img src=x onerror=alert(1)> could help. Write to hello@prepyr.com. PrepyrData stays plain.';body.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
  assert.equal(preview.querySelectorAll('a[href="https://prepyr.com/"]').length,1);assert.equal(preview.querySelector('img'),null);assert.match(preview.textContent!,/hello@prepyr.com/);assert.match(preview.textContent!,/PrepyrData stays plain/);
  assert.equal(requests.filter(r=>r.path.endsWith('/edit')).length,0);await click('#draft-form button[type=submit]');assert.equal(requests.filter(r=>r.path.endsWith('/edit')).length,1);
  assert.ok(doc.querySelector('#email-preview a[href="https://prepyr.com/"]'));
 }finally{dom.window.close();}
});
