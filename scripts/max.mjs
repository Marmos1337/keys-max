import {makeConfig} from '../server/config.mjs';
import {maxRequest} from '../server/bot.mjs';
const command=process.argv[2]||'check';
try{
 const c=makeConfig();if(!c.botToken)throw Error('Заполните MAX_BOT_TOKEN в .env. Токен не нужно присылать в чат.');
 if(!['check','register'].includes(command))throw Error('Используйте check или register.');
 const me=await maxRequest(c,'GET','/me');console.log('MAX API отвечает. Бот:',me.username||me.first_name||me.user_id);
 if(c.botUsername&&me.username&&c.botUsername!==me.username)throw Error('MAX_BOT_USERNAME не совпадает с ботом этого токена. Исправьте .env.');
 if(command==='check'){const r=await maxRequest(c,'GET','/subscriptions');console.log('Подписки:');for(const x of r.subscriptions||[])console.log(' -',x.url);console.log('Проверка API завершена. Это ещё не проверка доставки webhook или Mini App.');}
 else{
  if(c.mode!=='production')throw Error('Регистрация webhook разрешена только в APP_MODE=production.');
  const url=new URL(c.publicUrl);if(url.protocol!=='https:'||url.port)throw Error('Нужен HTTPS-домен на стандартном порту 443.');
  const health=await fetch(c.publicUrl+'/api/health',{signal:AbortSignal.timeout(10000)});if(!health.ok)throw Error('PUBLIC_URL/api/health недоступен. Сначала запустите сервер.');
  const data=await health.json();if(data.mode!=='production')throw Error('По PUBLIC_URL сейчас открыт не production. Не подключайте бота к демо.');
  await maxRequest(c,'POST','/subscriptions',{url:c.publicUrl+'/api/max/webhook',secret:c.webhookSecret,update_types:['bot_started','message_created','message_callback','bot_stopped','dialog_removed']});
  console.log('Webhook зарегистрирован:',c.publicUrl+'/api/max/webhook');console.log('Теперь укажите URL Mini App в настройках бота:',c.publicUrl);console.log('Отправьте боту /start и пройдите контрольный сценарий из docs/MAX_SETUP.md.');
 }
}catch(e){console.error('Ошибка:',e.message);if(e.cause?.code)console.error('Сетевая причина:',e.cause.code);console.error('При проблеме сертификата: docs/MAX_SETUP.md. Не отключайте TLS-проверку.');process.exit(1);}
