import {readdirSync} from 'node:fs';import {spawnSync} from 'node:child_process';import path from 'node:path';import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');let count=0;
for(const dir of ['server','public','scripts','tests'])for(const name of readdirSync(path.join(root,dir))){if(!/\.(mjs|js)$/.test(name))continue;const r=spawnSync(process.execPath,['--check',path.join(root,dir,name)],{stdio:'inherit'});if(r.status!==0)process.exit(r.status||1);count++;}
console.log(`Syntax OK: ${count} JavaScript files`);
const tests=readdirSync(path.join(root,'tests')).filter(x=>x.endsWith('.test.mjs')).map(x=>path.join(root,'tests',x));const r=spawnSync(process.execPath,['--test','--test-concurrency=1',...tests],{cwd:root,stdio:'inherit'});process.exit(r.status||0);
