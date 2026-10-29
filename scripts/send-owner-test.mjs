import fs from 'node:fs';
import assert from 'node:assert/strict';
import {readEnv} from './env.mjs';
import {gmail,mimeMessage,sendGmail} from '../src/providers.ts';
const e=readEnv(),base=e.APP_URL,recipient='shukla.rushi.52@gmail.com';
const file='artifacts/owner-test-rushi-sender.json';
if(fs.existsSync(file)){console.log('Existing test-send record found; no second email submitted.');process.exit(0);}
const headers={Origin:base,'X-Requested-With':'Prepyr','Content-Type':'application/json'};
const login=await fetch(base+'/api/login',{method:'POST',headers,body:JSON.stringify({password:e.ADMIN_PASSWORD})});assert.equal(login.status,200,'Relay login failed');headers.Cookie=login.headers.get('set-cookie').split(';')[0];
async function get(path){const r=await fetch(base+path,{headers});assert.equal(r.status,200,'Relay read failed');return r.json();}
try{
 const d=await get('/api/dashboard');
 assert.equal(d.connections.sender,'rushi@prepyr.com','Hosted sender is not rushi@prepyr.com');
 assert.equal(e.SENDER_EMAIL,d.connections.sender,'Local and hosted sender differ');
 const aliases=await gmail(e,'settings/sendAs');
 assert.ok(aliases.sendAs?.some(a=>a.sendAsEmail===e.SENDER_EMAIL&&a.verificationStatus==='accepted'),'Gmail has not accepted this sending address');
 const draft=d.drafts.find(x=>x.kind==='initial'&&x.status==='pending'&&!x.quality_hold&&x.company.includes('AAA Restaurant'))||d.drafts.find(x=>x.kind==='initial'&&x.status==='pending'&&!x.quality_hold);
 assert.ok(draft,'No researched email available for the test');
 const preview=await get(`/api/drafts/${draft.id}/preview`);
 assert.ok(preview.from.includes('<rushi@prepyr.com>'));assert.ok(preview.body.includes(d.settings.businessAddress));assert.ok(preview.body.includes('https://www.linkedin.com/in/rushi-shukla-77567994/'));
 // A test copy must not include a live prospect's unsubscribe link.
 const sample=preview.body.split('\n\nBusiness proposal.')[0];
 const body=`Test copy for Rushi: this is a sample outreach email. No prospect was contacted.\n\n${sample}\n\nBusiness proposal. To stop future emails, reply “unsubscribe”.`;
 const subject='Relay test — rushi@prepyr.com';
 const messageId=`<relay-owner-test-${crypto.randomUUID()}@prepyr.com>`;
 const record={state:'submitting',from:e.SENDER_EMAIL,to:recipient,subject,messageId,sourceDraftId:draft.id,createdAt:new Date().toISOString()};
 fs.writeFileSync(file,JSON.stringify(record,null,2),{flag:'wx'});
 try{
  const result=await sendGmail(e,mimeMessage({from:e.SENDER_EMAIL,name:d.settings.senderName,to:recipient,subject,body,messageId}));
  assert.ok(result.id,'Gmail did not return a message ID');
  Object.assign(record,{state:'accepted',gmailMessageId:result.id,threadId:result.threadId});fs.writeFileSync(file,JSON.stringify(record,null,2));
  const sent=await gmail(e,`messages/${result.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject`);
  const meta=Object.fromEntries(sent.payload.headers.map(h=>[h.name.toLowerCase(),h.value]));
  assert.ok(meta.from.includes('rushi@prepyr.com'));assert.ok(meta.to.includes(recipient));assert.ok(sent.labelIds.includes('SENT'));
  record.verifiedInSent=true;fs.writeFileSync(file,JSON.stringify(record,null,2));
  console.log(JSON.stringify({state:record.state,from:meta.from,to:meta.to,subject:meta.subject,verifiedInSent:true},null,2));
 }catch(error){if(record.state==='submitting'){record.state='uncertain';fs.writeFileSync(file,JSON.stringify(record,null,2));}throw error;}
}finally{await fetch(base+'/api/logout',{method:'POST',headers,body:'{}'});}
