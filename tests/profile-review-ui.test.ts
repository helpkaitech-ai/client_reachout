import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
import worker from '../src/index';
import {database,testSettings} from './helpers';
import {all,run,settings} from '../src/db';
import {saveProduct,product,scopeProduct} from '../src/products';

const analysis={productSummary:'Review a prepared CSV and create charts and reports.',valueProposition:'Reviewable reporting workflows',targetCustomers:['Professionals who own recurring CSV reports'],buyingRoles:['Report owner'],targetingRationale:'Owns the reporting workflow',qualificationCriteria:['Public evidence of recurring reporting'],exclusions:['Requires automatic multi-file joins'],remarksApplied:['Keep buyer budget unknown until evidenced'],emailGuidance:'Keep inferred needs conditional',unknowns:['Buyer budget availability','Purchase authority','Current buying intent'],sources:[{url:'https://product.example.com/features',observation:'Reviewable reports'}],campaigns:[{query:'reporting professionals',location:'London, UK',country:'GB',timezone:'Europe/London',enabled:true}]};
async function boot(options:{approved?:boolean;paused?:boolean;automation?:boolean;pipeline?:any}={}){
 const {env,close}=database(),base=env.APP_URL!,ctx={waitUntil:()=>{}} as unknown as ExecutionContext;
 env.ENABLE_AUTOMATION='true';env.ENABLE_SENDING='false';
 await run(env,'INSERT INTO settings VALUES(1,?)',JSON.stringify({...testSettings,prospectingPaused:true,discoveryPaused:true}));
 const p=await saveProduct(env,{name:'Review demo',website:'https://product.example.com',description:'A CSV reporting product',remarks:'Separate evidence from inference; mark buyer budgets unknown.',sender_email:'data@prepyr.com'});
 await run(env,'UPDATE products SET analysis=?,state=?,approved_revision=? WHERE id=?',JSON.stringify(analysis),options.approved?'approved':'target_review',options.approved?p.revision:null,p.id);
 const scope=await scopeProduct(env,await product(env,p.id)),s=await settings(scope),paused=options.paused!==false;
 await run(scope,'UPDATE settings SET data=?',JSON.stringify({...s,prospectingPaused:paused,discoveryPaused:paused,researchAutomation:options.automation!==false,providerPolicyConfirmed:false}));
 const login=await worker.fetch(new Request(base+'/api/login',{method:'POST',headers:{Origin:base,'X-Requested-With':'Prepyr'},body:JSON.stringify({password:env.ADMIN_PASSWORD})}),env,ctx),cookie=login.headers.get('set-cookie')!.split(';')[0];
 const dom=new JSDOM(fs.readFileSync('public/index.html','utf8'),{url:base+'/?product='+p.id,runScripts:'outside-only'}),doc=dom.window.document,requests:{path:string;method:string}[]=[];
 (dom.window.HTMLDialogElement.prototype as any).showModal=function(){this.open=true;};
 (dom.window.HTMLDialogElement.prototype as any).close=function(){this.open=false;};
 (dom.window as any).fetch=async(path:string,init:any)=>{
  requests.push({path,method:init.method});
  const response=await worker.fetch(new Request(base+path,{...init,headers:{...init.headers,Origin:base,Cookie:cookie}}),env,ctx);
  if(path.startsWith('/api/dashboard')&&options.pipeline){const data:any=await response.json();return Response.json({...data,pipeline:{...data.pipeline,...options.pipeline}});}
  return response;
 };
 const until=async(check:()=>boolean)=>{for(let i=0;i<200;i++){if(check())return;await new Promise(r=>setTimeout(r,10));}throw Error('Profile UI timed out: '+doc.querySelector('#toast')?.textContent);};
 const click=(selector:string)=>(doc.querySelector(selector) as HTMLElement).click();
 dom.window.eval(fs.readFileSync('public/app.js','utf8'));await until(()=>!!doc.querySelector('[data-discovery-control]'));
 return {env,scope,p,dom,doc,requests,until,click,close:()=>{dom.window.close();close();}};
}

test('pending target approval has one actionable notice; both prospect controls stay disabled across refreshes',async()=>{
 const x=await boot();try{
  assert.equal(x.doc.querySelectorAll('#content .note.warning').length,1);
  assert.equal(x.doc.querySelectorAll('.workspace-notice li').length,1);
  assert.equal(x.doc.querySelector('#content')!.firstElementChild?.classList.contains('workspace-notice'),true);
  assert.match(x.doc.querySelector('.workspace-notice')!.textContent!,/Review and approve the target profile/);
  for(const selector of ['[data-discovery-control]','[data-action="discover"]'])assert.equal((x.doc.querySelector(selector) as HTMLButtonElement).disabled,true);
  await x.dom.window.eval('load()');assert.equal(x.doc.querySelectorAll('#content .note.warning').length,1);
  x.click('[data-go="products"]');await x.until(()=>!!x.doc.querySelector('.profile-review'));
  assert.equal(x.doc.querySelectorAll('.profile-review li').length,4);
  assert.equal(x.doc.querySelector('[data-product-approve]')!.hasAttribute('disabled'),false);
  assert.match(x.doc.querySelector('.product-research')!.textContent!,/Unknowns do not have to be empty/);
  const source=x.doc.querySelector('a[href="https://product.example.com/features"]')!;assert.equal((source.closest('details') as HTMLDetailsElement).open,false);
  assert.equal(x.requests.some(r=>r.method==='POST'),false);
  assert.equal((await all(x.scope,'SELECT * FROM ai_attempts')).length,0);
 }finally{x.close();}
});

test('answering unknowns opens editable product remarks without saving, approving or spending',async()=>{
 const x=await boot();try{
  x.click('[data-go="products"]');await x.until(()=>!!x.doc.querySelector('.profile-review'));
  const answers=[...x.doc.querySelectorAll('[data-product-edit]')].find(b=>b.textContent==='Add answers or corrections') as HTMLElement;answers.click();
  await x.until(()=>!!x.doc.querySelector('#product-form'));
  assert.match((x.doc.querySelector('[name="remarks"]') as HTMLTextAreaElement).value,/mark buyer budgets unknown/);
  assert.equal(x.requests.some(r=>r.method==='POST'),false);
  assert.equal((await product(x.env,x.p.id)).state,'target_review');
  assert.equal((await settings(x.scope)).prospectingPaused,true);
  assert.equal((await all(x.scope,'SELECT * FROM ai_attempts')).length,0);
 }finally{x.close();}
});

test('explicit target approval accepts unknown buyer facts and leaves prospecting paused until separate resume',async()=>{
 const x=await boot();try{
  x.click('[data-go="products"]');await x.until(()=>!!x.doc.querySelector('[data-product-approve]'));
  x.click('[data-product-approve]');await x.until(()=>!!x.doc.querySelector('#toast')?.textContent?.includes('Customer profile approved'));
  const saved=await product(x.env,x.p.id);assert.equal(saved.state,'approved');assert.equal(saved.approved_revision,saved.revision);
  assert.deepEqual(JSON.parse(saved.analysis).unknowns,analysis.unknowns);
  assert.equal((await settings(x.scope)).prospectingPaused,true);
  x.click('[data-view="prospects"]');await x.until(()=>!!x.doc.querySelector('[data-discovery-control]'));
  assert.equal(x.doc.querySelectorAll('#content .note.warning').length,1);
  assert.equal(x.doc.querySelectorAll('.workspace-notice li').length,1);
  assert.match(x.doc.querySelector('.workspace-notice')!.textContent!,/Prospecting is paused/);
  assert.equal((x.doc.querySelector('[data-discovery-control]') as HTMLButtonElement).disabled,false);
  assert.equal((x.doc.querySelector('[data-action="discover"]') as HTMLButtonElement).disabled,true);
  const writes=x.requests.filter(r=>r.method==='POST');assert.equal(writes.length,1);assert.match(writes[0].path,/\/approve$/);
  assert.equal((await all(x.scope,'SELECT * FROM ai_attempts')).length,0);assert.equal((await all(x.scope,'SELECT * FROM messages')).length,0);
 }finally{x.close();}
});

test('settings distinguish the saved research cap and unknown buyer budget from the sending acknowledgement',async()=>{
 const x=await boot();try{
  x.click('[data-view="settings"]');await x.until(()=>!!x.doc.querySelector('#settings-form'));
  const text=x.doc.querySelector('#settings-form')!.textContent!;
  assert.match(text,/spending ceiling, not approval for each search/);assert.match(text,/prospect's purchasing budget in Unknowns is unrelated/);
  assert.match(text,/acknowledgement applies to sending emails, not product analysis or prospect research/);
  assert.equal((x.doc.querySelector('[name="providerPolicyConfirmed"]') as HTMLInputElement).checked,false);
  assert.equal(x.requests.some(r=>r.method==='POST'),false);
 }finally{x.close();}
});

test('a healthy active workspace has no false sending warning when no draft awaits sending',async()=>{
 const x=await boot({approved:true,paused:false});try{assert.equal(x.doc.querySelectorAll('#content .note.warning').length,0);}finally{x.close();}
});

test('actual billing and task warnings are separate bullets in one box without duplicate paused-task warnings',async()=>{
 const x=await boot({approved:true,paused:false,pipeline:{providerBlock:{code:'credit_balance_exhausted'},pausedJobs:4,attentionJobs:2}});try{
  assert.equal(x.doc.querySelectorAll('#content .note.warning').length,1);assert.equal(x.doc.querySelectorAll('.workspace-notice li').length,2);
  assert.match(x.doc.querySelector('.workspace-notice')!.textContent!,/OpenAI stopped requests for a billing problem/);
  assert.match(x.doc.querySelector('.workspace-notice')!.textContent!,/2 tasks need review/);assert.doesNotMatch(x.doc.querySelector('.workspace-notice')!.textContent!,/4 tasks are paused/);
 }finally{x.close();}
});
