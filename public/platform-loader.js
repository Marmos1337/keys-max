// Picks the messenger bridge before the app starts. Telegram passes tgWebApp* launch
// parameters in the URL hash (kept in sessionStorage by its SDK after in-app navigation);
// everything else keeps the original MAX bridge.
(function () {
  var hash = location.hash || '', search = location.search || '', telegram = false;
  if (/(^|[#&])tgWebApp(Data|Version|Platform)=/.test(hash) || /[?&]tgWebAppStartParam=/.test(search) || window.TelegramWebviewProxy) telegram = true;
  try {
    if (!telegram && (sessionStorage.getItem('__telegram__initParams') || sessionStorage.getItem('keys.platform') === 'telegram')) telegram = true;
    sessionStorage.setItem('keys.platform', telegram ? 'telegram' : 'max');
  } catch (e) {}
  window.__keysPlatform = telegram ? 'telegram' : 'max';
  document.documentElement.dataset.platform = window.__keysPlatform;
  var script = document.createElement('script');
  script.src = telegram ? 'https://telegram.org/js/telegram-web-app.js' : 'https://st.max.ru/js/max-web-app.js';
  window.__keysBridge = new Promise(function (resolve) { script.onload = script.onerror = function () { resolve(); }; });
  document.head.appendChild(script);
})();
