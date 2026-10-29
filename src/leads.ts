import type {Env,Campaign} from './types';
import {now,one,run,uid,day,BudgetPaused} from './db';
import {cleanEmail,publicUrl,validTimezone} from './policy';
import {domainOf} from './evidence';
export function entityKey(company:string,website:string,city:string){return [domainOf(website),company.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,''),city.normalize('NFKC').toLowerCase().trim()].join('|');}
export async function importLead(env:Env,input:any,campaign?:Campaign){
 const company=String(input.company||input.title||input.name||'').trim().slice(0,200);if(!company)throw new Error('Business name is required');
 const website=publicUrl(input.website)||'',email=cleanEmail(input.email)||(Array.isArray(input.emails)?input.emails.map(cleanEmail).find(Boolean):null)||null;
 if(!website&&!email)throw new Error('A business website or email is required');
 const zone=String(campaign?.timezone||input.timezone||'UTC');if(!validTimezone(zone))throw new Error('Invalid timezone');
 const city=String(input.city||'').trim().slice(0,120),domain=domainOf(website);
 const existing=await one<any>(env,"SELECT id FROM leads WHERE (? IS NOT NULL AND email=?) OR (domain=? AND lower(company)=lower(?) AND lower(city)=lower(?) AND domain<>'') LIMIT 1",email,email,domain,company,city);
 if(existing)return null;
 if(env.PRODUCT_ID&&(await one<{n:number}>(env,'SELECT COUNT(*) n FROM leads WHERE created_at>=?',day()+'T00:00:00.000Z'))!.n>=20)throw new BudgetPaused('This product reached its 20 new leads per UTC day allowance');
 const id=uid(),at=now();const r=await run(env,`INSERT OR IGNORE INTO leads(id,company,website,domain,email,phone,country,city,industry,timezone,source_url,contact_name,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,id,company,website,domain,email,String(input.phone||'').slice(0,80),String(campaign?.country||input.country||input.countryCode||'').slice(0,80),city,String(input.industry||input.categoryName||campaign?.query||'').slice(0,200),zone,publicUrl(input.source_url||input.url)||website,String(input.contact_name||'').slice(0,120),at,at);
 return r.meta.changes?id:null;
}
