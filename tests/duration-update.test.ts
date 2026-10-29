import {test} from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Small one-time migration helper is JavaScript.
import {durationFor,extendText} from '../scripts/pilot-duration-plan.mjs';
test('duration edits preserve owner-selected longer terms and update end references',()=>{
 assert.equal(durationFor('The Order Chef',{workflow:'Wholesale enquiry follow-up'},'I would build a free 60-day pilot.').days,60);
 assert.equal(extendText('A free 10-day pilot ends after 10 days, on day 10. A 10 ft. product.',10,45),'A free 45-day pilot ends after 45 days, on day 45. A 10 ft. product.');
 assert.equal(durationFor('HOLT CAT Austin',{workflow:'Excavator quotes'}).days,60);
 assert.equal(durationFor('Unknown business',{workflow:'Repair updates'}).days,30);
});
