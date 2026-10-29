import type { Env } from './types';
import { digest } from './policy';
export class AuthUnavailable extends Error {
 constructor(){super('Sign-in is temporarily unavailable. Please try again shortly.');}
}
export function sameSecret(a:string,b:string) {
 const x=new TextEncoder().encode(a),y=new TextEncoder().encode(b);let diff=x.length^y.length;
 for(let i=0;i<Math.max(x.length,y.length);i++)diff|=(x[i]||0)^(y[i]||0);
 return diff===0;
}
async function store(env:Env,path:string,key:string,expiresAt?:number):Promise<any> {
 try {
  if(!env.AUTH_STORE||!env.SESSION_SECRET)throw new Error('Missing authentication configuration');
  const id=env.AUTH_STORE.idFromName(await digest('relay-auth:'+env.SESSION_SECRET));
  const response=await env.AUTH_STORE.get(id).fetch('https://auth.internal'+path,{method:'POST',body:JSON.stringify({key,expiresAt})});
  if(!response.ok)throw new Error('Authentication storage failed');
  return await response.json();
 }catch{throw new AuthUnavailable();}
}
function token(request:Request){return request.headers.get('Cookie')?.match(/(?:^|;\s*)prepyr_session=([^;]+)/)?.[1];}
export async function authenticated(request:Request,env:Env) {
 const value=token(request);if(!value||!/^v2_[A-Za-z0-9_-]{43}$/.test(value))return false;
 return (await store(env,'/check',await digest(value))).valid===true;
}
export function csrf(request:Request) {
 return request.headers.get('Origin')===new URL(request.url).origin&&request.headers.get('X-Requested-With')==='Prepyr';
}
export async function login(request:Request,env:Env,password:string) {
 if(!env.ADMIN_PASSWORD||!env.SESSION_SECRET)throw new AuthUnavailable();
 const key=await digest(request.headers.get('CF-Connecting-IP')||'local');
 if(!(await store(env,'/attempt',key)).allowed)throw new Error('Too many login attempts. Try again in 15 minutes.');
 if(!sameSecret(await digest(password),await digest(env.ADMIN_PASSWORD)))throw new Error('Incorrect password');
 const value='v2_'+Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
 await store(env,'/create',await digest(value),Date.now()+12*3600000);
 await store(env,'/reset',key);
 return `prepyr_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${new URL(request.url).protocol==='https:'?'; Secure':''}`;
}
export async function logout(request:Request,env:Env) {
 const value=token(request);if(value)await store(env,'/delete',await digest(value));
 return 'prepyr_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Secure';
}
