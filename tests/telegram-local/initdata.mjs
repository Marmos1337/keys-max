// Prints a URL hash that imitates a Telegram launch, signed with the local test token.
import {createHmac} from 'node:crypto';
const [token,id,name,scheme='light',start='']=process.argv.slice(2);
const p=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),query_id:'local-run',user:JSON.stringify({id:Number(id),first_name:name,allows_write_to_pm:true,language_code:'ru'}),...(start?{start_param:start}:{})});
const data=[...p].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${k}=${v}`).join('\n');
p.set('hash',createHmac('sha256',createHmac('sha256','WebAppData').update(token).digest()).update(data).digest('hex'));
const theme=scheme==='dark'?{bg_color:'#17212b',text_color:'#f5f5f5',button_color:'#5288c1',button_text_color:'#ffffff'}:{bg_color:'#ffffff',text_color:'#000000',button_color:'#2481cc',button_text_color:'#ffffff'};
const h=new URLSearchParams({tgWebAppData:p.toString(),tgWebAppVersion:'8.0',tgWebAppPlatform:'ios',tgWebAppThemeParams:JSON.stringify(theme)});
console.log('#'+h.toString());
