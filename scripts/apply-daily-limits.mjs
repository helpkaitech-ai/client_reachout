import fs from 'node:fs';
import path from 'node:path';
import {query} from './cloudflare.mjs';
import {root} from './env.mjs';

// Only these three settings change; existing sender, approvals, quotas and
// provider settings are preserved. Safe against both application versions.
const desired={dailyResearchLimit:20,dailyNewLimit:12,dailyTotalLimit:12};
const report={at:new Date().toISOString(),desired,status:'pending'};
const target=path.join(root,'artifacts/daily-limits.json');
try{
 const response=query("UPDATE settings SET data=json_set(data,'$.dailyResearchLimit',20,'$.dailyNewLimit',12,'$.dailyTotalLimit',12) WHERE id=1 RETURNING json_extract(data,'$.dailyResearchLimit') dailyResearchLimit,json_extract(data,'$.dailyNewLimit') dailyNewLimit,json_extract(data,'$.dailyTotalLimit') dailyTotalLimit;")[0];
 const observed=response.results[0];
 if(!observed||Object.keys(desired).some(k=>observed[k]!==desired[k]))throw Error('Daily limits could not be verified');
 report.status='live_verified';report.observed=observed;
 console.log('Verified live daily limits: 20 researched leads, 12 new emails, 12 total emails.');
}catch(error){report.status='pending';report.error=error.message;throw error;}
finally{fs.writeFileSync(target,JSON.stringify(report,null,2));}
