import path from 'node:path';
import { randomBytes } from 'node:crypto';
export function makeConfig(env=process.env) {
  const mode=env.APP_MODE||'demo';
  if(!['demo','production','test'].includes(mode)) throw Error('APP_MODE: demo | production | test');
  const production=mode==='production';
  const c={mode,production,port:Number(env.PORT||3000),host:env.HOST||'127.0.0.1',publicUrl:(env.PUBLIC_URL||'http://localhost:3000').replace(/\/$/,''),dataDir:path.resolve(env.DATA_DIR||'data'),secret:env.SESSION_SECRET||randomBytes(32).toString('hex'),botToken:env.MAX_BOT_TOKEN||'',botUsername:env.MAX_BOT_USERNAME||'',webhookSecret:env.MAX_WEBHOOK_SECRET||'',deepLinkBase:(env.MAX_DEEPLINK_BASE||'https://max.ru').replace(/\/$/,''),apiBase:(env.MAX_API_BASE||'https://platform-api2.max.ru').replace(/\/$/,''),timezone:env.TZ||'Europe/Moscow',trustProxy:env.TRUST_PROXY==='1',operator:env.OPERATOR_NAME||'',support:env.SUPPORT_EMAIL||'',privacyUrl:env.PRIVACY_URL||'',termsUrl:env.TERMS_URL||''};
  if(!/^https:\/\/[^/]+$/.test(c.deepLinkBase)) throw Error('MAX_DEEPLINK_BASE must be an HTTPS origin.');
  new Intl.DateTimeFormat('en-CA',{timeZone:c.timezone}).format();
  if(production) {
    if(!env.SESSION_SECRET||env.SESSION_SECRET.length<32) throw Error('SESSION_SECRET must be at least 32 characters. Run npm run setup.');
    if(!/^https:\/\/[^/]+$/.test(c.publicUrl)) throw Error('Production PUBLIC_URL must be an HTTPS origin, without path.');
    if(!c.botToken||!c.botUsername||!c.webhookSecret.match(/^[a-zA-Z0-9_-]{32,256}$/)) throw Error('Set MAX_BOT_TOKEN, MAX_BOT_USERNAME and MAX_WEBHOOK_SECRET (32+ safe characters).');
    if(!c.apiBase.startsWith('https://')) throw Error('MAX API must use HTTPS.');
    if(!c.operator||!c.support||![c.privacyUrl,c.termsUrl].every(x=>/^https:\/\//.test(x))) throw Error('Set OPERATOR_NAME, SUPPORT_EMAIL, PRIVACY_URL and TERMS_URL before real users.');
  }
  return c;
}
