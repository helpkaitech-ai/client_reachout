import {test} from 'node:test';
import assert from 'node:assert/strict';
import {specificOfferProblem} from '../src/research';
import {pilotBody as body,pilotOffer as freeOffer} from './pilot-fixture';
const allowed=new Set([freeOffer.sourceUrl]);
test('document-only incentives fail even when personalized and sourced',()=>{
 for(const deliverable of ['DIN flange routing spec','DIN flange inquiry spec','DIN flange one-pager','DIN flange checklist','DIN flange audit'])assert.ok(specificOfferProblem({body,freeOffer:{...freeOffer,deliverable}},allowed));
});
test('working pilot requires a period, useful workflow, scope and measurable outcome',()=>{
 assert.equal(specificOfferProblem({body,freeOffer},allowed),'');
 for(const update of [{durationDays:365},{durationDays:7},{workflow:''},{scope:''},{successMetric:''},{outcome:'generic_demo'},{type:'document'}])assert.ok(specificOfferProblem({body,freeOffer:{...freeOffer,...update}},allowed));
});
test('long emails and vague free offers are held for improvement',()=>{
 assert.ok(specificOfferProblem({body:body+' more'.repeat(116),freeOffer},allowed));
 const vague='I can send you a free one-pager about the DIN pump flanges.';
 assert.ok(specificOfferProblem({body:vague,freeOffer:{...freeOffer,emailExcerpt:vague}},allowed));
});
test('pilots allow 30, 45 and 60 days and reject shorter, mismatched or unexplained periods',()=>{
 for(const days of [30,45,60]){
  const revised=body.replaceAll('30-day',`${days}-day`),offer={...freeOffer,durationDays:days,emailExcerpt:freeOffer.emailExcerpt.replaceAll('30-day',`${days}-day`)};
  assert.equal(specificOfferProblem({body:revised,freeOffer:offer},allowed),'');
  assert.ok(specificOfferProblem({body:revised,freeOffer:{...offer,durationReason:''}},allowed));
 }
 for(const days of [7,10,14,29,31,90])assert.ok(specificOfferProblem({body,freeOffer:{...freeOffer,durationDays:days}},allowed));
 assert.ok(specificOfferProblem({body,freeOffer:{...freeOffer,durationDays:45}},allowed));
 assert.ok(specificOfferProblem({body:body+' The pilot ends after 10 days.',freeOffer},allowed));
});
