import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {linkedProductText,productLink,composedHtml,composedBody} from '../src/mail';
import {mimeMessage} from '../src/providers';
import {database,readyLead,readyDraft,testSettings} from './helpers';

test('product mentions link the saved website, with safe escaping and no partial-name or URL/email corruption',()=>{
 const text='Try Prepyr. PREPYR’s charts & <script>bad()</script>\nNot PrepyrData or myPrepyr. https://prepyr.com/a or hello@prepyr.com';
 const dom=new JSDOM(linkedProductText(text,{name:'Prepyr',website:'https://prepyr.com/?a=1&b=2'})),doc=dom.window.document;
 try{assert.equal(doc.querySelectorAll('a').length,2);assert.deepEqual([...doc.querySelectorAll('a')].map(a=>a.textContent),['Prepyr','PREPYR']);assert.ok([...doc.querySelectorAll('a')].every(a=>a.href==='https://prepyr.com/?a=1&b=2'));assert.equal(doc.querySelector('script'),null);assert.match(doc.body.textContent!,/https:\/\/prepyr.com\/a or hello@prepyr.com/);assert.match(doc.body.textContent!,/Not PrepyrData or myPrepyr/);}finally{dom.window.close();}
});

test('product link handles punctuation and rejects unsafe destinations or missing product context',()=>{
 const name='A+B (Data)';assert.match(linkedProductText('Try '+name,{name,website:'https://example.com'}),/<a /);
 for(const website of ['javascript:alert(1)','data:text/html,bad','http://localhost','https://user:password@example.com'])assert.doesNotMatch(linkedProductText('Prepyr <img>',{name:'Prepyr',website}),/<a|<img/);
 assert.equal(productLink({PRODUCT_BRIEF:'bad json'}),undefined);assert.equal(productLink({PRODUCT_BRIEF:'{}'}),undefined);
 assert.deepEqual(productLink({PRODUCT_BRIEF:JSON.stringify({name:'Prepyr',website:'https://prepyr.com'})}),{name:'Prepyr',website:'https://prepyr.com/'});
});

test('final MIME includes clickable product mentions and one unsubscribe link while keeping the plain-text alternative',async()=>{
 const {env,close}=database();try{
  const lead=await readyLead(env),draft=await readyDraft(env,lead);draft.body='Hi Jane,\n\nPrepyr could help explore your sales data.';
  const url='https://relay.example/unsubscribe?signed=1',product={name:'Prepyr',website:'https://prepyr.com'},html=composedHtml(draft,testSettings,url,product),body=composedBody(draft,testSettings,url);
  const raw=Buffer.from(mimeMessage({from:'sender@example.com',name:'Sender',to:lead.email!,subject:draft.subject,body,html,messageId:'<fixture@example.com>',unsubscribe:url}),'base64url').toString();
  assert.ok(raw.replace(/\r\n/g,'').includes(Buffer.from(html).toString('base64')));assert.ok(raw.replace(/\r\n/g,'').includes(Buffer.from(body).toString('base64')));
  const dom=new JSDOM(html);try{const anchors=[...dom.window.document.querySelectorAll('a')];assert.deepEqual(anchors.map(a=>a.textContent),['Prepyr','Unsubscribe']);assert.equal(anchors[0].href,'https://prepyr.com/');assert.doesNotMatch(dom.window.document.body.textContent!,/https:\/\/prepyr/);}finally{dom.window.close();}
 }finally{close();}
});
