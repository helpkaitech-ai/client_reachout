import http from 'node:http';
import { randomBytes,createHash } from 'node:crypto';
import { readEnv,updateEnv } from './env.mjs';
const e=readEnv();if(!e.GOOGLE_CLIENT_ID||!e.GOOGLE_CLIENT_SECRET)throw new Error('Fill GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first.');
const state=randomBytes(24).toString('base64url'),verifier=randomBytes(48).toString('base64url');
const redirect='http://localhost:8788/callback';
const auth=new URL('https://accounts.google.com/o/oauth2/v2/auth');
auth.search=new URLSearchParams({client_id:e.GOOGLE_CLIENT_ID,redirect_uri:redirect,response_type:'code',access_type:'offline',prompt:'consent',scope:'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.settings.basic',state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}).toString();
const server=http.createServer(async(req,res)=>{const u=new URL(req.url,'http://localhost:8788');if(u.pathname!=='/callback'){res.writeHead(404);res.end();return;}if(u.searchParams.get('state')!==state){res.writeHead(400);res.end('Invalid authorization state.');return;}try{
 if(!u.searchParams.get('code'))throw new Error('Google did not return an authorization code');
 const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:e.GOOGLE_CLIENT_ID,client_secret:e.GOOGLE_CLIENT_SECRET,code:u.searchParams.get('code'),code_verifier:verifier,grant_type:'authorization_code',redirect_uri:redirect})});
 const data=await r.json();if(!r.ok||!data.refresh_token)throw new Error('Google token exchange failed or no refresh token was issued');
 updateEnv({GOOGLE_REFRESH_TOKEN:data.refresh_token});res.writeHead(200,{'Content-Type':'text/plain'});res.end('Google connected. The refresh token was saved privately to .env. You may close this tab and run npm run deploy.');console.log('Google refresh token saved to .env. No token printed.');
}catch(error){res.writeHead(400,{'Content-Type':'text/plain'});res.end('Authorization failed. See terminal for a safe error summary.');console.error(error.message);}finally{server.close();}});
server.listen(8788,'localhost',()=>{console.log('Open this Google authorization URL in your browser and sign in with your business mailbox:');console.log(auth.href);console.log('The one-time setup listener closes after authorization. The deployed app does not require this computer.');});
setTimeout(()=>server.close(),10*60*1000).unref();
