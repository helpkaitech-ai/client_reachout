import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {query} from './cloudflare.mjs';
import {root} from './env.mjs';

// Explicit owner-requested one-time hold. Re-running the operation must not
// keep moving its end date forward or touch research, budgets or approvals.
const target=path.join(root,'artifacts/discovery-schedule.json');
const existing=fs.existsSync(target)?JSON.parse(fs.readFileSync(target,'utf8')):null;
const pausedUntil=existing?.pausedUntil||new Date(Date.now()+3*86400000).toISOString();
assert.equal(new Date(pausedUntil).toISOString(),pausedUntil);
const before=query("SELECT json_extract(data,'$.discoveryIntervalDays') intervalDays,json_extract(data,'$.discoveryPausedUntil') pausedUntil FROM settings WHERE id=1")[0].results[0];
assert.ok(before,'Existing Relay settings must exist');
const report={at:new Date().toISOString(),pausedUntil,intervalDays:3,before,status:'pending'};
fs.mkdirSync(path.dirname(target),{recursive:true});
fs.writeFileSync(target,JSON.stringify(report,null,2));
const after=query(`UPDATE settings SET data=json_set(data,'$.discoveryIntervalDays',3,'$.discoveryPausedUntil','${pausedUntil}') WHERE id=1 RETURNING json_extract(data,'$.discoveryIntervalDays') intervalDays,json_extract(data,'$.discoveryPausedUntil') pausedUntil`)[0].results[0];
assert.deepEqual(after,{intervalDays:3,pausedUntil});
Object.assign(report,{status:'live_verified',after});fs.writeFileSync(target,JSON.stringify(report,null,2));
console.log(JSON.stringify({intervalDays:3,pausedUntil,existingResearchUnchanged:true}));
