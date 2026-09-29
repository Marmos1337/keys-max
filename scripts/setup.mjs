import {existsSync,readFileSync,writeFileSync,chmodSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import path from 'node:path';import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const [major,minor]=process.versions.node.split('.').map(Number);
if(major<22||(major===22&&minor<16)){console.error('Нужен Node.js 22.16+ (ветки 22 или 24 LTS).');process.exit(1);}
const target=path.join(root,'.env');if(existsSync(target)){console.log('.env уже существует — настройки и секреты сохранены без изменений.');}else{let s=readFileSync(path.join(root,'.env.example'),'utf8');s=s.replace(/^SESSION_SECRET=$/m,'SESSION_SECRET='+randomBytes(32).toString('hex')).replace(/^MAX_WEBHOOK_SECRET=$/m,'MAX_WEBHOOK_SECRET='+randomBytes(32).toString('base64url'));writeFileSync(target,s,{mode:0o600,flag:'wx'});try{chmodSync(target,0o600);}catch{}console.log('Создан .env с уникальными секретами. Режим: локальное демо.');}
console.log('Далее: npm start\nОткрыть: http://localhost:3000\nДля подключения MAX: docs/MAX_SETUP.md\nДля production используйте отдельный каталог данных, не базу демо.');
