// Owner-approved extension, with proposed observation windows based on recorded workflows.
const longer={
 'South Austin Metals':[45,'Custom cutting and fabrication enquiries need time to progress from requirements to quotes.'],
 'Core & Main':[45,'Estimating and take-off requests involve reviewing project specifications before an order.'],
 'Mitchell Industrial Dolly Innovations':[45,'Custom and retrofit equipment enquiries need a longer window to clarify site and load requirements.'],
 'Wilson Company - Hydraulic Equipment Supplier':[45,'Hydraulic equipment and custom-work quote follow-ups need multiple rounds of technical clarification.'],
 'White Cap':[45,'Construction product quotes and jobsite fulfilment need a longer window to observe purchase decisions.'],
 'Johnson Equipment Company':[60,'Loading-dock and industrial-door projects can require a site visit and a subsequent equipment quote.'],
 'Austin Industrial Refrigeration':[60,'Commercial refrigeration installation estimates benefit from a longer window to observe project decisions.'],
 'Eurofins | MET Labs Austin':[45,'Product-safety testing enquiries require market and deadline qualification before a quote.'],
 'HOLT CAT Austin':[60,'Excavator purchase enquiries concern capital equipment, warranting a longer proposed evaluation period.'],
 'Centex Material Handling':[60,'Equipment-relocation work requires photos, drawings and project timing before commercial decisions.'],
 'Megladon Manufacturing Group':[45,'Custom fibre-assembly projects need specification clarification before a quote can progress.'],
 'Konrad Supply':[60,'Government and industrial procurement requests need specification and delivery checks before quotation.'],
 'Century HVAC Distributing':[60,'Larger commercial HVAC system quotes warrant more time to observe contractor decisions.'],
 'AAA Restaurant Equipment & Supply Co':[45,'Commercial kitchen equipment quotes for opening businesses benefit from several follow-up cycles.'],
};
export function durationFor(company,offer,body=''){const selected=body.match(/\bfree\s+(30|45|60)[-– ]day\s+pilot\b/i);if(selected)return {days:Number(selected[1]),reason:'Preserve the longer trial period already selected in the owner-edited email.'};const entry=longer[company];return entry?{days:entry[0],reason:entry[1]}:{days:30,reason:`A month allows repeated observations of the proposed ${offer.workflow.toLowerCase()} The actual business cycle has not been measured.`};}
export function extendText(text,oldDays,newDays){return String(text).replace(new RegExp(`\\b${oldDays}([-– ]days?)\\b`,'gi'),`${newDays}$1`).replace(new RegExp(`\\bday ${oldDays}\\b`,'gi'),`day ${newDays}`);}
