import type { Campaign, Settings } from './types';
type Place={id:string;label:string;country:string;countryName:string;region:string;timezone:string};
const rows=[
 ['london','London, UK','GB','United Kingdom','Europe','Europe/London'],
 ['bengaluru','Bengaluru, India','IN','India','Asia','Asia/Kolkata'],
 ['singapore','Singapore','SG','Singapore','Asia','Asia/Singapore'],
 ['dubai','Dubai, UAE','AE','United Arab Emirates','Middle East','Asia/Dubai'],
 ['cape-town','Cape Town, South Africa','ZA','South Africa','Africa','Africa/Johannesburg'],
 ['sydney','Sydney, Australia','AU','Australia','Oceania','Australia/Sydney'],
 ['toronto','Toronto, Canada','CA','Canada','North America','America/Toronto'],
 ['new-york','New York, USA','US','United States','North America','America/New_York'],
 ['dublin','Dublin, Ireland','IE','Ireland','Europe','Europe/Dublin'],
 ['berlin','Berlin, Germany','DE','Germany','Europe','Europe/Berlin'],
 ['amsterdam','Amsterdam, Netherlands','NL','Netherlands','Europe','Europe/Amsterdam'],
 ['paris','Paris, France','FR','France','Europe','Europe/Paris'],
 ['madrid','Madrid, Spain','ES','Spain','Europe','Europe/Madrid'],
 ['milan','Milan, Italy','IT','Italy','Europe','Europe/Rome'],
 ['auckland','Auckland, New Zealand','NZ','New Zealand','Oceania','Pacific/Auckland'],
 ['kuala-lumpur','Kuala Lumpur, Malaysia','MY','Malaysia','Asia','Asia/Kuala_Lumpur'],
 ['manila','Manila, Philippines','PH','Philippines','Asia','Asia/Manila'],
 ['nairobi','Nairobi, Kenya','KE','Kenya','Africa','Africa/Nairobi'],
 ['sao-paulo','Sao Paulo, Brazil','BR','Brazil','South America','America/Sao_Paulo'],
 ['mexico-city','Mexico City, Mexico','MX','Mexico','North America','America/Mexico_City'],
 ['manchester','Manchester, UK','GB','United Kingdom','Europe','Europe/London'],
 ['birmingham','Birmingham, UK','GB','United Kingdom','Europe','Europe/London'],
 ['mumbai','Mumbai, India','IN','India','Asia','Asia/Kolkata'],
 ['delhi','Delhi, India','IN','India','Asia','Asia/Kolkata'],
 ['hyderabad','Hyderabad, India','IN','India','Asia','Asia/Kolkata'],
 ['austin','Austin, Texas, USA','US','United States','North America','America/Chicago'],
 ['chicago','Chicago, USA','US','United States','North America','America/Chicago'],
 ['los-angeles','Los Angeles, USA','US','United States','North America','America/Los_Angeles'],
 ['denver','Denver, USA','US','United States','North America','America/Denver'],
 ['vancouver','Vancouver, Canada','CA','Canada','North America','America/Vancouver'],
 ['melbourne','Melbourne, Australia','AU','Australia','Oceania','Australia/Melbourne'],
 ['perth','Perth, Australia','AU','Australia','Oceania','Australia/Perth'],
 ['abu-dhabi','Abu Dhabi, UAE','AE','United Arab Emirates','Middle East','Asia/Dubai'],
 ['johannesburg','Johannesburg, South Africa','ZA','South Africa','Africa','Africa/Johannesburg'],
];
export const places:Place[]=rows.map(([id,label,country,countryName,region,timezone])=>({id:'city:'+id,label,country,countryName,region,timezone}));
export const locationOptions=[{id:'worldwide',label:'Worldwide — varied locations',group:'Worldwide'},
 ...[...new Set(places.map(p=>p.region))].map(region=>({id:'region:'+region,label:region,group:'Regions'})),
 ...[...new Map(places.map(p=>[p.country,p.countryName])).entries()].map(([code,name])=>({id:'country:'+code,label:name,group:'Countries'})),
 ...places.map(p=>({id:p.id,label:p.label,group:'Cities'}))];
export function validateLocations(value:unknown):string[]{
 if(!Array.isArray(value)||!value.length||value.length>50||value.some(id=>typeof id!=='string'||!locationOptions.some(o=>o.id===id)))throw new Error('Select at least one location from the dropdown.');
 const ids=[...new Set(value as string[])];return ids.includes('worldwide')?['worldwide']:ids;
}
export function expandLocations(ids:string[]):Place[]{
 return places.filter(p=>ids.some(id=>id==='worldwide'||id===p.id||id==='country:'+p.country||id==='region:'+p.region));
}
export type SearchHistory={location:string;country:string;uses:number;last_used:string};
const industries=['commercial maintenance companies','industrial equipment suppliers','corporate training providers','event venues','packaging manufacturers','equipment rental','commercial cleaning companies','wholesale suppliers','auto repair shops','logistics companies','furniture manufacturers','printing companies'];
export function nextCampaign(s:Settings,history:SearchHistory[],scope?:string[]):Campaign{
 const choices=expandLocations(validateLocations(scope||s.locationIds||['worldwide']));
 const countryUses=(p:Place)=>history.filter(h=>h.country===p.country).reduce((n,h)=>n+Number(h.uses),0);
 const usage=(p:Place)=>history.find(h=>h.location===p.label);
 choices.sort((a,b)=>countryUses(a)-countryUses(b)||Number(usage(a)?.uses||0)-Number(usage(b)?.uses||0)||(usage(a)?.last_used||'').localeCompare(usage(b)?.last_used||''));
 const p=choices[0],count=history.reduce((n,h)=>n+Number(h.uses),0);
 return {query:industries[count%industries.length],location:p.label,country:p.country,timezone:p.timezone,enabled:true};
}
export function manualSearchPlan(s:Settings,history:SearchHistory[]):Campaign[]{
 const chosen:Campaign[]=[];const simulated=[...history];
 for(const scope of validateLocations(s.locationIds||['worldwide'])){const c=nextCampaign(s,simulated,[scope]);if(chosen.some(x=>x.location===c.location))continue;chosen.push(c);simulated.push({location:c.location,country:c.country,uses:1,last_used:new Date().toISOString()});}
 return chosen;
}
export function nextProductCampaign(s:Settings,history:SearchHistory[]):Campaign{
 const choices=s.campaigns.filter(c=>c.enabled);if(!choices.length)throw new Error('Generate a customer profile with enabled search scopes first');
 const count=history.reduce((n,h)=>n+Number(h.uses),0),query=choices[count%choices.length].query;
 const ids=validateLocations(s.locationIds||['worldwide']);
 const places=expandLocations(ids).sort((a,b)=>{
  const usage=(p:Place)=>history.filter(h=>h.location===p.label).reduce((n,h)=>n+Number(h.uses),0);
  const countryUsage=(p:Place)=>history.filter(h=>h.country===p.country).reduce((n,h)=>n+Number(h.uses),0);
  return countryUsage(a)-countryUsage(b)||usage(a)-usage(b);
 });
 const p=places[0];if(!p)throw new Error('Select a valid product search location');
 // The query is always OpenAI-derived; owner locations only constrain geography.
 return {query,location:p.label,country:p.country,timezone:p.timezone,enabled:true};
}
