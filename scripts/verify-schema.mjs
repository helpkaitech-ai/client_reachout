import fs from 'node:fs';
import {query} from './cloudflare.mjs';
const expected=fs.readdirSync('migrations').filter(x=>x.endsWith('.sql'));
const applied=query('SELECT name FROM d1_migrations;')[0].results.map(r=>r.name);
const missing=expected.filter(x=>!applied.includes(x));if(missing.length)throw Error('Required database migrations missing: '+missing.join(', '));
query('SELECT id FROM ai_attempts LIMIT 0; SELECT id FROM discovery_batches LIMIT 0; SELECT id FROM products LIMIT 0; SELECT contact_status FROM leads LIMIT 0;');
console.log('Verified all release migrations, required tables and columns.');
