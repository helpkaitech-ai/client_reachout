import {test} from 'node:test';
import assert from 'node:assert/strict';
import {collectSources,containsExcerpt,sourceKey,discoveryWebsite} from '../src/evidence';
import {fetchSourcePage,groundedExcerpt,sourcePages,pageText} from '../src/source-pages';
import {discoveryQueries} from '../src/discovery-plan';
import {database} from './helpers';

test('completed page provenance survives later citations while search results and interrupted opens stay snippets',()=>{
 const url='https://example.com/reporting',other='https://example.com/search-only';
 const sources=collectSources({output:[{type:'web_search_call',status:'completed',action:{type:'open_page',url}},{type:'web_search_call',status:'searching',action:{type:'open_page',url:other}},{type:'message',content:[{annotations:[{url},{url:other}]}]}]});
 assert.equal(sources.find(s=>s.url===url)?.evidenceType,'opened_page');assert.equal(sources.find(s=>s.url===other)?.evidenceType,'snippet');
});
test('verbatim quote formatting is accepted without accepting disjoint quotes or invented words',()=>{
 const text='We prepare monthly financial reports and reconcile accounts for our clients.';
 assert.equal(containsExcerpt(text,'“We prepare monthly financial reports”'),true);
 assert.equal(containsExcerpt(text,'“monthly financial reports” and “our clients”'),false);
 assert.equal(containsExcerpt(text,'We automate monthly financial reports'),false);
});
test('public mailto links survive page extraction without inferring addresses from labels or scripts',()=>{
 const text=pageText('<p>Monthly reports.</p><a href="mailto:hello%40business.example?subject=Hello">Email us</a><script><a href="mailto:fake@evil.example">Hidden</a></script><a href="/contact">info [at] business.example</a>');
 assert.match(text,/hello@business.example/);assert.doesNotMatch(text,/fake@evil.example|info@business.example/);
});
test('discovery seeds omit contact and file-format constraints while retaining city and reporting workflow',()=>{
 const campaign={query:'monthly reporting CSV export email',location:'Bengaluru, India',country:'IN',timezone:'Asia/Kolkata',enabled:true};
 assert.deepEqual(discoveryQueries(campaign),['Bengaluru monthly reporting']);
});
test('internal report-owner roles cannot turn approved business discovery into a job search',()=>{
 const campaign={query:'business analyst operational investigation CSV export',location:'Bengaluru, India',country:'IN',timezone:'Asia/Kolkata',enabled:true};
 assert.deepEqual(discoveryQueries(campaign,undefined,['Analytics teams','Marketing agencies','Bookkeeping firms','Professional services firms']),['Bengaluru Marketing agencies','Bengaluru Bookkeeping firms','Bengaluru Professional services firms']);
 assert.deepEqual(discoveryQueries(campaign,undefined,['Marketing agencies','Bookkeeping firms'],1),['Bengaluru Bookkeeping firms','Bengaluru Marketing agencies']);
});
test('tracking parameters cannot turn a fetched page into an apparently unconsulted source',()=>{
 assert.equal(sourceKey('https://www.business.example/report?id=2&utm_source=openai#report'),sourceKey('https://business.example/report?id=2'));
 assert.notEqual(sourceKey('https://business.example/report?id=2'),sourceKey('https://business.example/report?id=3'));
});
test('bare business domains gain a scheme only from an exact consulted source hostname',()=>{
 const sources=[{url:'https://www.hkjain.com/services/monthly-reporting/'}];
 assert.equal(discoveryWebsite('hkjain.com',sources),'https://www.hkjain.com/');
 assert.equal(discoveryWebsite('invented.example',sources),null);assert.equal(discoveryWebsite('javascript:alert(1)',sources),null);
});
test('contact lookup follows an actual same-domain link after finding the workflow page',async()=>{
 const db=database(),original=globalThis.fetch,calls:string[]=[];
 globalThis.fetch=(async(url:any)=>{calls.push(String(url));return new Response(String(url).endsWith('/contact')?'<p>General business enquiries: hello@business.example. Our office is in Bengaluru.</p>':'<p>We prepare monthly reports for clients.</p><a href="/contact">Contact us</a><a href="http://127.0.0.1/private">Contact</a>',{headers:{'content-type':'text/html'}});}) as typeof fetch;
 try{const pages=await sourcePages(db.env,'business:pages',['https://business.example/reporting']);assert.equal(pages.length,2);assert.deepEqual(calls,['https://business.example/reporting','https://business.example/contact']);assert.match(pages[1].text,/hello@business.example/);}finally{globalThis.fetch=original;db.close();}
});
test('public page snapshots decode literal emails, ignore script text and are reused across checkpoints',async()=>{
 const db=database(),original=globalThis.fetch;let calls=0;
 globalThis.fetch=(async()=>{calls++;return new Response('<html><script>fake@evil.example</script><p>Monthly reports for clients. Email info&#64;business.example for enquiries.</p></html>',{headers:{'content-type':'text/html'}});}) as typeof fetch;
 try{const pages=await sourcePages(db.env,'sample:pages',['https://business.example/reporting']);assert.equal(pages.length,1);assert.match(pages[0].text,/info@business.example/);assert.doesNotMatch(pages[0].text,/fake/);
  assert.equal(groundedExcerpt(pages[0].url,'Email info@business.example for enquiries.',pages[0].text,[],pages),true);
  assert.equal(groundedExcerpt(pages[0].url,'We struggle with messy spreadsheets every day.', 'We struggle with messy spreadsheets every day.',[{url:pages[0].url,title:'',evidenceType:'opened_page'}],pages),false);
  await sourcePages(db.env,'sample:pages',['https://business.example/other']);assert.equal(calls,1);
 }finally{globalThis.fetch=original;db.close();}
});
test('blocked, oversized and private redirect pages never become evidence',async()=>{
 const original=globalThis.fetch;let calls=0;
 try{
  globalThis.fetch=(async()=>{calls++;return new Response(null,{status:302,headers:{location:'http://127.0.0.1/admin'}});}) as typeof fetch;
  assert.equal(await fetchSourcePage('https://business.example/contact'),null);assert.equal(calls,1);
  assert.equal(await fetchSourcePage('http://localhost/contact'),null);assert.equal(calls,1);
  globalThis.fetch=(async()=>new Response('x'.repeat(385*1024),{headers:{'content-type':'text/html'}})) as typeof fetch;
  assert.equal(await fetchSourcePage('https://business.example/contact'),null);
  globalThis.fetch=(async()=>new Response('Access denied',{status:403,headers:{'content-type':'text/html'}})) as typeof fetch;
  assert.equal(await fetchSourcePage('https://business.example/contact'),null);
  assert.equal(pageText('<p>A &amp; B</p><style>not evidence</style>'),'A & B');
 }finally{globalThis.fetch=original;}
});

test('current campaign location replaces locations embedded in generated profile queries',()=>{
 const campaign={query:'startup finance analysis Singapore',location:'United States',country:'US',timezone:'America/New_York',enabled:true};
 assert.deepEqual(discoveryQueries(campaign,undefined,[],0,['Singapore, Singapore']),['United States startup finance analysis']);
});
