import {cleanEmail,publicUrl} from './policy';
import {domainOf} from './evidence';

export function verifiedMailbox(row:any){
 return row?.status==='good'&&row.technical_status==='valid'&&row.reason==='ok'&&row.free===false&&row.role===false&&row.disposable===false&&row.catch_all===false&&row.mailInfrastructureFound===true;
}
export function workAddress(email:unknown,website:string){
 const address=cleanEmail(email);if(!address||!domainOf(website))return null;
 if(/^(?:info|hello|contact|sales|support|help|admin|privacy|billing|success|jobs|careers|no-?reply)@/i.test(address))return null;
 const host=address.split('@')[1];if(/^(?:gmail|googlemail|outlook|hotmail|yahoo|icloud|aol|proton|protonmail|live)\./i.test(host))return null;
 return domainOf('https://'+host)===domainOf(website)?address:null;
}
export function verifiedWorkContact(c:any,email:unknown,website:string){
 const address=workAddress(email,website);
 return !!address&&c?.email===address&&c.status==='provider_verified'&&c.evidenceType==='provider_verification'&&c.identityConfirmed===true&&c.provider==='apify/thirdwatch-email-verifier'&&verifiedMailbox(c.verification)&&c.verification.email===address&&/^[a-zA-Z0-9]+$/.test(c.verificationRunId||'')&&/^[a-zA-Z0-9]+$/.test(c.enrichmentRunId||'')&&c.companyDomain===domainOf(website)&&!!publicUrl(c.profileUrl)&&/^https:\/\/(?:[a-z]+\.)?linkedin\.com\/in\/[^/?#]+/.test(c.profileUrl)&&Date.parse(c.observedAt)>=Date.now()-30*86400000&&Date.parse(c.observedAt)<=Date.now()+300000;
}
