import fs from 'node:fs';
const migrations=fs.readdirSync('migrations').filter(f=>f.endsWith('.sql')).sort().map(name=>({name,sql:fs.readFileSync('migrations/'+name,'utf8').replace(/^PRAGMA foreign_keys = ON;\s*/m,'')}));
fs.writeFileSync('src/product-schema.ts','// Generated from migrations. Each workspace applies missing migrations transactionally.\nexport const productMigrations='+JSON.stringify(migrations)+';\n');
