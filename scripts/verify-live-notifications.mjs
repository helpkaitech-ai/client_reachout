import assert from 'node:assert/strict';
import {readEnv} from './env.mjs';
const e=readEnv(),base=e.APP_URL;
const headers={Origin:base,'X-Requested-With':'Prepyr','Content-Type':'application/json'};
const login=await fetch(base+'/api/login',{method:'POST',headers,body:JSON.stringify({password:e.ADMIN_PASSWORD})});
assert.equal(login.status,200);headers.Cookie=login.headers.get('set-cookie').split(';')[0];
async function dashboard(){const r=await fetch(base+'/api/dashboard',{headers});assert.equal(r.status,200);return r.json();}
try{
 const before=await dashboard();
 assert.equal(before.settings.businessAddress,'G-401, Royal Legend, Bengaluru - 560068, India');
 assert.equal(before.connections.sendingEnabled,true);
 assert.equal(before.drafts.filter(d=>d.status==='approved').length,0);
 const known=new Set(before.notifications.map(n=>n.id));
 const r=await fetch(base+'/api/notify',{method:'POST',headers,body:'{}'});assert.equal(r.status,200);
 const after=await dashboard(),created=after.notifications.filter(n=>!known.has(n.id));
 for(const channel of ['telegram','email'])assert.ok(created.some(n=>n.channel===channel&&n.state==='sent'),channel+' notification failed');
 assert.equal(after.messages.filter(m=>m.status==='sent').length,before.messages.filter(m=>m.status==='sent').length);
 console.log(JSON.stringify({addressSaved:true,sendingEnabled:true,notifications:created.map(n=>({channel:n.channel,state:n.state})),prospectMessagesUnchanged:true},null,2));
}finally{await fetch(base+'/api/logout',{method:'POST',headers,body:'{}'});}
