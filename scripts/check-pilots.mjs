import fs from 'node:fs';
import assert from 'node:assert/strict';
import {offerVersion,linkedIn,workingPilotProblem} from '../src/offers.ts';
const data=JSON.parse(fs.readFileSync('artifacts/after-pilot-refresh.json','utf8'));
const drafts=data.drafts.filter(d=>JSON.parse(d.free_offer||'{}').version===offerVersion);
for(const d of drafts){
 const offer=JSON.parse(d.free_offer),lead=data.leads.find(l=>l.id===d.lead_id);
 assert.ok(d.body.includes(linkedIn),lead.company+': LinkedIn missing');
 assert.match(d.body,/12\+ years/);assert.match(d.body,/currently work at Adobe/);
 assert.equal(d.artifact,'');assert.equal(d.status,'pending');
 assert.ok(d.body.split(/\s+/).length<=160,lead.company+': email too long');
 if(!d.quality_hold){
  const body=d.body.slice(d.body.indexOf(linkedIn)+linkedIn.length).trim();
  assert.equal(workingPilotProblem({body,freeOffer:offer}),'',lead.company);
  assert.ok(body.includes(offer.emailExcerpt),lead.company+': offer not inline');
  assert.ok(JSON.parse(lead.research).sources.some(s=>s.url===offer.sourceUrl),lead.company+': source missing');
 }
}
assert.ok(drafts.length>0,'No rewritten pilots');
const report={checkedAt:new Date().toISOString(),checked:drafts.length,ready:drafts.filter(d=>!d.quality_hold).length,held:drafts.filter(d=>d.quality_hold).length,unsent:true};
fs.writeFileSync('artifacts/pilot-validation.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
if(process.argv.includes('--show'))for(const d of drafts)console.log('\n'+d.company+' | '+d.subject+' | '+(d.quality_hold||'Ready')+'\n'+d.body);
