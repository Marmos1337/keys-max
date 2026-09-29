import { fail } from './auth.mjs';
export function text(v,label,max=2000,optional=false){if(optional&&(v===undefined||v===null||v===''))return '';if(typeof v!=='string'||!v.trim()||v.trim().length>max)fail(400,`${label}: заполните поле (до ${max} символов).`);return v.trim();}
export function integer(v,label,min=0,max=1_000_000_000){if(!Number.isSafeInteger(v)||v<min||v>max)fail(400,`${label}: допустимо целое число от ${min} до ${max}.`);return v;}
export function choice(v,options,label='Значение'){if(!options.includes(v))fail(400,`${label}: недопустимое значение.`);return v;}
export function date(v,label='Дата'){if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(Date.parse(v))||new Date(v).toISOString().slice(0,10)!==v)fail(400,`${label}: укажите корректную дату.`);return v;}
export function instant(v){if(typeof v!=='string'||!/(Z|[+-]\d\d:\d\d)$/.test(v)||!Number.isFinite(Date.parse(v)))fail(400,'Некорректное время. Нужен часовой пояс.');return new Date(v).toISOString();}
export function visitTimes(p,now=Date.now()){const start=instant(p.start),end=instant(p.end),a=Date.parse(start),b=Date.parse(end);if(a<now+60_000||b<=a||b-a>8*3600_000||a>now+366*86400_000)fail(400,'Посещение: выберите будущее время и длительность не больше 8 часов.');return {start,end};}
export function own(obj){return obj&&typeof obj==='object'&&!Array.isArray(obj)?obj:{};}
export function attachmentIds(v){if(v===undefined)return [];if(!Array.isArray(v)||v.length>5||v.some(x=>typeof x!=='string'||x.length>80)||new Set(v).size!==v.length)fail(400,'Можно прикрепить до 5 разных файлов.');return v;}
