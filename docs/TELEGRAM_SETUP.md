# Telegram: Ключи 0.4.x

С версии 0.4.0 Ключи работают в двух мессенджерах из одного кода и одной базы:
MAX (как раньше) и Telegram. MAX-пользователи ничего не замечают: их вход,
бот, уведомления и ссылки не менялись. Telegram включается только когда задан
токен бота; без токена Telegram-часть спит.

## Как это устроено

- Клиент. `public/platform-loader.js` до старта приложения смотрит на адрес:
  Telegram передаёт параметры запуска `tgWebAppData…` в hash. Тогда грузится
  `https://telegram.org/js/telegram-web-app.js`, иначе прежний мост MAX.
  `public/platform.js` — единый адаптер: подписанные данные запуска, тема
  (в режиме «Как на устройстве» тема следует Telegram), цвет шапки и фона,
  кнопка «Назад» в шапке Telegram, вибро-отклик, подтверждение закрытия,
  скачивание файлов (`downloadFile`, Bot API 8.0, иначе `openLink`),
  «Поделиться» через `t.me/share/url`, открытие бота через `openTelegramLink`,
  запрос разрешения писать в личку (`requestWriteAccess`).
  Safe-area: CSS-токены `--safe-top/--safe-bottom` учитывают и `env()`, и
  переменные Telegram `--tg-(content-)safe-area-inset-*`.
- Вход. `POST /api/auth/telegram` проверяет initData по документации Telegram:
  secret = HMAC_SHA256(ключ "WebAppData", токен бота), подпись строки
  `key=value` по алфавиту без `hash`, свежесть `auth_date` (1 час), дубли
  параметров. Пользователь Telegram хранится в `users.tg_id`.
- Бот. С 0.4.1 по умолчанию **long polling** (`KEYS_TG_MODE=polling`): сервер
  сам забирает обновления `getUpdates` (timeout 50 с). Причина: входящие
  соединения от серверов Telegram до домашнего сервера не доходят (провайдер),
  webhook получал «Connection timed out», а исходящие запросы к api.telegram.org
  работают. Опрос ведёт один процесс: аренда-замок в таблице `bot_state`
  (продлевается перед каждым запросом, 120 с), второй экземпляр ждёт в standby.
  Апдейты пишутся в `webhook_inbox` (дубли по `update_id` отсекаются) вместе
  с новым offset в одной транзакции; offset сохраняется в `bot_state`, после
  перезапуска опрос продолжается с него (offset старше суток не используется).
  Ошибки сети — экспоненциальная пауза до 60 с, 429 — `retry_after`, 401 —
  5 минут. При запуске сервер снимает webhook с `drop_pending_updates=false`,
  поэтому накопленные апдейты не теряются. Состояние: `GET /api/health` →
  `telegram` (state, updates, failures, last_ok_s) и строки `tg_poll` в логе
  (heartbeat раз в 30 минут). Режим `KEYS_TG_MODE=webhook` сохранён: webhook
  `POST /api/telegram/webhook` с секретом в заголовке
  `X-Telegram-Bot-Api-Secret-Token`; в режиме polling этот адрес отвечает 404.
  Оба режима складывают апдейты в ту же очередь `webhook_inbox`, что и MAX. Обработчик общий: приглашения `/start join_…`
  с подтверждением кнопкой, подтверждение посещения, `/help`, `/stop`,
  `/notifications`, подключение аккаунта `/start link_…`. Только личные чаты.
- Уведомления. Для каждого подключённого мессенджера пользователя создаётся
  отдельная строка `outbox` (поле `channel` в JSON), поэтому сбой одного канала
  не дублирует сообщение в другом. Кнопки Telegram открывают Mini App через
  `web_app`-кнопку с `?startapp=r_…/c_…/l_…/m_…`. 403 (бот заблокирован)
  выключает только Telegram-доставку; 429 учитывает `retry_after`.
- Связка аккаунтов. Существующий MAX-пользователь в Профиле → «Мессенджеры:
  MAX и Telegram» получает одноразовый код (10 символов, 15 минут). В Telegram
  он открывает Ключи и вводит код (или открывает ссылку на бота и жмёт
  «Подключить»). Telegram-идентичность переходит к его аккаунту: квартиры,
  аренды и история общие, уведомления приходят в оба мессенджера. Пустой
  аккаунт, созданный при первом входе из Telegram, отдаёт идентичность;
  аккаунт с данными не перезаписывается (ошибка 409). То же работает в
  обратную сторону (Telegram → MAX).
- База. Добавлены только колонки `users.tg_id`, `users.tg_bot_enabled` и
  таблица `account_links`. `schema_version` остаётся 3, поэтому откат кода на
  0.3.6 открывает ту же базу.

## Что нужно один раз (владелец)

1. Бот уже создан в BotFather (@rentkeysbot). Если нужен новый: `/newbot`,
   затем токен.
2. В `.env` на сервере (права 600):
   ```
   KEYS_TG_BOT_TOKEN=<токен из BotFather>
   KEYS_TG_BOT_USERNAME=rentkeysbot
   KEYS_TG_MODE=polling            # по умолчанию; webhook — только если сервер доступен снаружи
   KEYS_TG_WEBHOOK_SECRET=<32+ символов, нужен только для webhook>
   ```
3. Перезапуск и регистрация:
   ```sh
   docker compose -p keys-prod -f compose.yaml -f compose.prod.yml -f compose.ca.yaml up -d --build app
   docker compose -p keys-prod -f compose.yaml -f compose.prod.yml -f compose.ca.yaml exec app node scripts/telegram.mjs register
   docker compose -p keys-prod -f compose.yaml -f compose.prod.yml -f compose.ca.yaml exec app node scripts/telegram.mjs check
   ```
   `register` в режиме polling снимает webhook (в webhook-режиме ставит его с
   секретом), задаёт кнопку меню «Ключи» (web_app на PUBLIC_URL), команды и
   описание бота на русском. `check` показывает режим, webhook и состояние опроса.
4. По желанию в BotFather: `/setuserpic`, а также `/mybots → Bot Settings →
   Configure Mini App` (Main Mini App на тот же URL) — тогда приложение видно
   в профиле бота и работают ссылки `t.me/rentkeysbot?startapp=…`.

## Проверка

- `node --test tests/telegram.test.mjs` — подпись, вход, бот, приглашения,
  связка аккаунтов, раздача уведомлений, ошибки 403/429.
- Локальный прогон: сервер в `APP_MODE=test` с тестовым токеном, браузер с
  подписанным hash `tgWebAppData` и записью событий моста; ширины 320–430,
  светлая и тёмная тема.
- Не проверено автоматически: настоящий клиент Telegram на iOS/Android/Desktop
  (вид шапки, скачивание файлов, жест «назад»). Пройти вручную после выкладки.
