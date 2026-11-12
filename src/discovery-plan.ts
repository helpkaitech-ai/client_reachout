import type {Campaign} from './types';
import type {ProductUseCase} from './product-fit';

export function discoveryQueries(campaign:Campaign,useCase?:ProductUseCase,customerTypes:string[]=[],index=0,profileLocations:string[]=[]){
 // An internal job title/workflow often retrieves vacancies rather than buyers.
 // Discover the owner's actual business segments first; qualify the observed
 // workflow on their pages. Team names stay in fit criteria, not query seeds.
 const segments=[...new Set(customerTypes.filter(t=>typeof t==='string'&&t.trim().length>=5&&t.trim().split(/\s+/).length<=6&&!/\bteams?\b/i.test(t)).map(t=>t.trim()))];
 const city=campaign.location.split(',')[0].trim();
 if(segments.length)return Array.from({length:Math.min(3,segments.length)},(_,i)=>`${city} ${segments[(index+i)%segments.length]}`);
 const phrases=useCase?.searchPhrases||[campaign.query];
 const locations=[...new Set(profileLocations.flatMap(l=>typeof l==='string'?l.split(','):[]).map(l=>l.trim()).filter(l=>l.length>2))];
 const stripLocations=(phrase:string)=>locations.reduce((text,location)=>text.replace(new RegExp('\\b'+location.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\b','gi'),' '),phrase);
 const clean=(phrase:string)=>stripLocations(phrase).replace(/\b(?:csv|xlsx?|excel|spreadsheet|exports?|e-?mail|contact|official site)\b/gi,' ').replace(/\s+/g,' ').trim().replace(/\b(?:from|with|for|in|to|each)\s*$/gi,'').trim();
 return [...new Set(phrases.map(clean).filter(q=>q.length>=8).map(q=>`${city} ${q.split(' ').slice(0,6).join(' ')}`))].slice(0,3);
}
export const discoveryStrategy=`This is the BUSINESS DISCOVERY pass. The application performs public-email lookup and page verification in a separate step after this response. Do not combine those tasks here.
Start with the supplied short businessQueries: the selected country, region or city plus ONE approved customer business type or professional service. Find the actual businesses first, then inspect their service pages for relevant responsibilities and business activity. Do not stack email, contact, CSV/Excel, exports, every fit signal or hypothetical problems into the query. Include a separate people-discovery angle using relevant professional roles and public profiles; do not require founder or owner status. Exclude job-board/careers pages as discovery sources; they are not usable business contact pages. Avoid product tutorials, software support articles and competing software vendors. The full product requirements are qualification criteria, not an AND-query. If a query returns documentation rather than businesses, change to the corresponding professional service or deliverable without relaxing the fit requirements.
Find up to maximumCandidates distinct businesses as a discovery pool; the application will select the best contactable matches later. Prefer the strongest evidenced responsibilities and relevant data-related activity, not the easiest email. Use the selected use case as a starting angle; another supported use case may be a stronger match. Search official service pages and open the most relevant workflow pages; use at least one search and reserve calls for source inspection. Do not repeat identical queries or opens. Do not search for contact emails or discard a strong workflow because its email is absent from the search snippet.
For each business give its name, official website, actual city/country, exact activity or responsibility source URL and a short continuous verbatim passage, responsible role and cadence only if known. No wrapping quotes, ellipses, joined quotations or invented person. Distinguish an observed workflow from inferred pain, unknown file suitability, purchasing authority and intent. Include contact page URLs only if already available. Research only: no pitch, offers or conversational next steps.`;
