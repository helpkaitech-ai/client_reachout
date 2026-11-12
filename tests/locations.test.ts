import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaults} from '../src/types';
import {places,nextCampaign,nextProductCampaign,manualSearchPlan,validateLocations,expandLocations,searchUserLocation,type SearchHistory} from '../src/locations';
import {database,testSettings} from './helpers';
import {run,one,all,now,enqueue,reserve} from '../src/db';
import {processDiscovery,tick} from '../src/engine';

test('all selectable cities have valid timezones and country codes without user input',()=>{for(const p of places){assert.match(p.country,/^[A-Z]{2}$/);assert.doesNotThrow(()=>new Intl.DateTimeFormat('en',{timeZone:p.timezone}));}assert.ok(new Set(places.map(p=>p.country)).size>=20);assert.equal(expandLocations(['country:US']).some(p=>p.timezone==='America/Los_Angeles'),true);assert.equal(expandLocations(['country:US']).some(p=>p.timezone==='America/New_York'),true);});
test('worldwide rotation visits different countries before repeating and keeps rotating cities',()=>{const history:SearchHistory[]=[];const chosen=[];for(let i=0;i<25;i++){const c=nextCampaign(defaults,history);chosen.push(c);history.push({location:c.location,country:c.country,uses:1,last_used:new Date(Date.now()+i*86400000).toISOString()});}assert.equal(new Set(chosen.slice(0,20).map(c=>c.country)).size,20);assert.ok(new Set(chosen.map(c=>c.location)).size>20);assert.ok(new Set(chosen.map(c=>c.query)).size>5);});
test('country or city selections restrict automatic search and produce a multi-location plan',()=>{const s={...defaults,locationIds:['country:IN','city:london']};const plan=manualSearchPlan(s,[]);assert.equal(plan.length,2);assert.equal(plan[0].country,'IN');assert.equal(plan[0].timezone,'Asia/Kolkata');assert.equal(plan[1].location,'London, UK');const countries=new Set(['IN','GB']);const history:SearchHistory[]=[];for(let i=0;i<8;i++){const c=nextCampaign(s,history);assert.ok(countries.has(c.country));history.push({location:c.location,country:c.country,uses:1,last_used:now()});}assert.throws(()=>validateLocations([]));assert.throws(()=>validateLocations(['made-up-place']));assert.deepEqual(validateLocations(['worldwide','country:IN']),['worldwide']);});


test('worldwide product searches diversify countries even when every saved profile scope is in Singapore',()=>{
 const s={...defaults,locationIds:['worldwide'],campaigns:Array.from({length:6},(_,i)=>({query:'Recurring reporting workflow '+i,location:'Singapore, Singapore',country:'SG',timezone:'Asia/Singapore',enabled:true}))};
 const history:SearchHistory[]=[],countries=new Set<string>();
 for(let i=0;i<20;i++){const c=nextProductCampaign(s,history);countries.add(c.country);assert.ok(s.campaigns.some(p=>p.query===c.query));history.push({location:c.location,country:c.country,uses:1,last_used:now()});}
 assert.equal(countries.size,20);
 const singapore=nextProductCampaign({...s,locationIds:['country:SG']},history);assert.equal(singapore.country,'SG');
});


test('country searches use the entire country for web and LinkedIn; cities and regions stay scoped',async()=>{
 const {actorInput}=await import('../src/apify');const plan={searchQuery:'operations',currentJobTitles:['Operations Manager']};
 for(const next of [nextCampaign,nextProductCampaign]){
  const s={...defaults,campaigns:[{query:'data analysis',location:'New York, USA',country:'US',timezone:'America/New_York',enabled:true}]};
  const national=next({...s,locationIds:['country:US']},[]);assert.equal(national.location,'United States');assert.equal(national.scope,'country');assert.deepEqual(searchUserLocation(national),{country:'US'});assert.deepEqual(actorInput(plan,national,0).locations,['United States']);
  const city=next({...s,locationIds:['city:austin']},[]);assert.deepEqual(searchUserLocation(city),{country:'US',city:'Austin'});assert.deepEqual(actorInput(plan,city,0).locations,['Austin, United States']);
  const area=next({...s,locationIds:['area:US-CA']},[]);assert.deepEqual(searchUserLocation(area),{country:'US',region:'California'});assert.deepEqual(actorInput(plan,area,0).locations,['California, United States']);
 }
});
