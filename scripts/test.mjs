import {readdirSync} from 'node:fs';import {spawnSync} from 'node:child_process';import path from 'node:path';import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),files=readdirSync(path.join(root,'tests')).filter(x=>x.endsWith('.test.mjs')).map(x=>path.join(root,'tests',x));
const r=spawnSync(process.execPath,['--test','--test-concurrency=1',...files],{cwd:root,stdio:'inherit'});process.exit(r.status??1);
