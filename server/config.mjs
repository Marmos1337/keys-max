import path from 'node:path';
import { randomBytes } from 'node:crypto';
export function makeConfig(env=process.env) {
  const mode=env.APP_MODE||'demo';
  if(!['demo','production','test'].includes(mode)) throw Error('APP_MODE: demo | production | test');
  const production=mode==='production';
  const c={mode,production,port:Number(env.PORT||3000),host:env.HOST||'127.0.0.1',publicUrl:(env.PUBLIC_URL||'http://localhost:3000').replace(/\/$/,''),dataDir:path.resolve(env.DATA_DIR||'data'),secret:env.SESSION_SECRET||randomBytes(32).toString('hex'),botToken:env.MAX_BOT_TOKEN||'',botUsername:env.MAX_BOT_USERNAME||'',webhookSecret:env.MAX_WEBHOOK_SECRET||'',deepLinkBase:(env.MAX_DEEPLINK_BASE||'https://max.ru').replace(/\/$/,''),apiBase:(env.MAX_API_BASE||'https://platform-api2.max.ru').replace(/\/$/,''),timezone:env.TZ||'Europe/Moscow',trustProxy:env.TRUST_PROXY==='1',operator:env.OPERATOR_NAME||'',support:env.SUPPORT_EMAIL||'',privacyUrl:env.PRIVACY_URL||'',termsUrl:env.TERMS_URL||'',
    // Telegram is an optional second platform. It stays dormant until the bot token is set.
    tgBotToken:env.KEYS_TG_BOT_TOKEN||'',tgBotUsername:(env.KEYS_TG_BOT_USERNAME||'').replace(/^@/,''),tgWebhookSecret:env.KEYS_TG_WEBHOOK_SECRET||'',tgApiBase:(env.KEYS_TG_API_BASE||'https://api.telegram.org').replace(/\/$/,''),
    // polling: the server pulls updates with getUpdates (works behind NAT or a blocked inbound route).
    // webhook: Telegram pushes updates to /api/telegram/webhook.
    tgMode:(env.KEYS_TG_MODE||'polling').toLowerCase()};
  c.telegram=!!c.tgBotToken;
  if(!['polling','webhook'].includes(c.tgMode)) throw Error('KEYS_TG_MODE: polling | webhook');
  if(!/^https:\/\/[^/]+$/.test(c.deepLinkBase)) throw Error('MAX_DEEPLINK_BASE must be an HTTPS origin.');
  new Intl.DateTimeFormat('en-CA',{timeZone:c.timezone}).format();
  if(production) {
    if(!env.SESSION_SECRET||env.SESSION_SECRET.length<32) throw Error('SESSION_SECRET must be at least 32 characters. Run npm run setup.');
    if(!/^https:\/\/[^/]+$/.test(c.publicUrl)) throw Error('Production PUBLIC_URL must be an HTTPS origin, without path.');
    const maxAny=c.botToken||c.botUsername||c.webhookSecret, maxReady=c.botToken&&c.botUsername&&/^[a-zA-Z0-9_-]{32,256}$/.test(c.webhookSecret);
    if((maxAny||!c.telegram)&&!maxReady) throw Error('Set MAX_BOT_TOKEN, MAX_BOT_USERNAME and MAX_WEBHOOK_SECRET (32+ safe characters).');
    if(!c.apiBase.startsWith('https://')) throw Error('MAX API must use HTTPS.');
    if(c.telegram) {
      if(!/^\d{5,16}:[A-Za-z0-9_-]{30,64}$/.test(c.tgBotToken)) throw Error('KEYS_TG_BOT_TOKEN does not look like a BotFather token.');
      if(!/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(c.tgBotUsername)) throw Error('Set KEYS_TG_BOT_USERNAME (bot username without @).');
      if((c.tgMode==='webhook'||c.tgWebhookSecret)&&!/^[A-Za-z0-9_-]{32,256}$/.test(c.tgWebhookSecret)) throw Error('Set KEYS_TG_WEBHOOK_SECRET (32+ characters: A-Z, a-z, 0-9, _ or -).');
      if(!c.tgApiBase.startsWith('https://')) throw Error('Telegram API must use HTTPS.');
    }
    if(!c.operator||!c.support||![c.privacyUrl,c.termsUrl].every(x=>/^https:\/\//.test(x))) throw Error('Set OPERATOR_NAME, SUPPORT_EMAIL, PRIVACY_URL and TERMS_URL before real users.');
  }
  return c;
}
