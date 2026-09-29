# HTTP API 0.3.6

Бизнес-контракт аренды сохранён; добавлен отдельный метод прогресса гайда. Health/config возвращают версию из package.json.

Машиночитаемая спецификация: `../openapi.yaml`, OpenAPI 3.1.0.
Она описывает маршруты/транспорт и общие схемы. Поля payload по видам уточнены
ниже; валидация конечных состояний находится в domain.mjs и покрыта тестами.

## Авторизация и ошибки

`POST /api/auth/max` принимает `{ "initData": "подписанная строка" }`.
Ответ: `token`, `expires`, `user`, `start_param`. Токен непрозрачный, не JWT.
В браузере хранится только в памяти и HttpOnly-cookie, не в localStorage.
API принимает `Authorization: Bearer <session-token>` либо cookie `keys_session`.
Это **сеансовый токен приложения**, не токен бота MAX.

Любой POST кроме webhook требует `X-Keys-Client: miniapp`; браузерный Origin
проверяется. Изменения domain также требуют `Idempotency-Key` (8–100 символов).
Один ключ относится к одному пользователю + пути + содержимому JSON.
Клиент повторяет тот же ключ только для того же действия.

Успех — JSON 200. Ошибка — `{ "error": "сообщение", "requestId": "uuid" }`.
400 валидация, 401 сеанс/подпись, 403 права/Origin, 404 скрытая или отсутствующая
сущность, 409 состояние/версия/повторный ключ, 413 размер, 429 темп, 500 сбой.

## Payload для POST /api/records

Общий envelope:

```json
{
  "lease_id": "UUID аренды",
  "kind": "ticket",
  "title": "Протекает кран",
  "payload": {"description": "Капает вода", "room": "Кухня", "priority": "normal"},
  "files": []
}
```

| kind | payload | Кто создаёт |
|---|---|---|
| ticket | description, room, priority: normal/urgent | участники |
| purchase | amount в копейках, purchase_date YYYY-MM-DD, description | арендатор |
| visit | start/end ISO с timezone, reason | собственник |
| charge | amount в копейках, due YYYY-MM-DD, period YYYY-MM, repeat:boolean, advance_days | собственник |
| reading | values: [{meter_id, value: целые тысячные}] | арендатор |
| document | category: contract/act/receipt/agreement/other, description, private | участники; private только собственник |
| expense | amount в копейках, date YYYY-MM-DD, description | собственник, всегда private |
| terms | rent в копейках, terms, due_day, effective_month YYYY-MM | собственник |
| termination | date YYYY-MM-DD, reason | участники |

В document обязателен минимум один ранее загруженный файл. Клиентский status,
created_by и visibility не принимаются как основание для изменения прав.

## Переходы

`POST /api/records/:id/action`, пример:

```json
{"action":"resolve","version":2,"note":"Заменили прокладку","files":[]}
```

`claim`/`record_payment`: amount, note, необязательные files; record_payment может указать payer_id участника.
`confirm`/`reject` для оплаты: claim_id конкретного ожидающего перевода и текущая version.
`counter`: start/end ISO с timezone.
`resolve`/`reopen`/`reject`: обязательное текстовое обоснование note.
`compensate`: необязательное note, без вызова банков.
Перечень разрешённых состояний/ролей — `ARCHITECTURE.md`.
409 требует перечитать состояние; нельзя просто увеличивать version вслепую.

## Файлы

1. `POST /api/files?lease_id=...&name=...` с **сырыми байтами**, не multipart/base64.
2. Сервер проверяет участие, размер, расширение/сигнатуру и сохраняет приватный файл.
3. Полученный id передать в `files` создания записи или действия.
4. `POST /api/files/:id/ticket` → `{url,name,mime}` после проверки доступа.
5. `GET url` → файл с Content-Disposition: attachment, ссылка на 5 минут.

Непривязанный файл доступен только загрузившему. После связи действуют права
записи. Непривязанные файлы старше 24 часов очищаются. Скачивание не раскрывает
физический путь. Проверка сигнатуры — не антивирусная проверка всего файла.

## Чтение и экспорт

`GET /api/state` возвращает только доступные квартиры/аренды/записи, метаданные
вложений, историю, уведомления, user и служебные даты. Секретов/путей файлов нет.
`GET /api/export` — JSON той же видимости.
`POST /api/export/ticket` — отдельная ссылка для нативного downloadFile.
Сами вложения экспорт JSON не упаковывает. История снимка ограничена 1000 событиями,
уведомления — 200; это не архив всей базы оператора. Для полного сохранения
используйте администраторский offline backup.

## Webhook и публичные маршруты

`POST /api/max/webhook` без пользовательского сеанса, но только с правильным
`X-Max-Bot-Api-Secret`. Тело — официальный Update. Дедупликация по callback_id,
message mid или хешу полного события. Ответ подтверждает приём в inbox,
не успешную отправку ответного сообщения MAX.
`/api/health` и `/api/config` публичны и не выводят секреты.

## Проверочный сценарий API

`tests/http.test.mjs` поднимает настоящий сервер на случайном локальном порту,
создаёт сеанс и проверяет маршруты. Не используйте токен production в тестовом
коде. Demo auth намеренно отсутствует в рабочем режиме. Для проверки реального
доступа жюри нужны две собственные тестовые учётные записи MAX и приглашение;
фиксированных логина/пароля в приложении нет.


## Редактирование квартиры (0.2.0)

`POST /api/apartments/:id` — только владелец карточки. Обязательны обычные
X-Keys-Client, Idempotency-Key и текущая `version` из GET /api/state. Например:

```json
{"version":1,"title":"Моя квартира","address":"Новый адрес","rooms":2,"area":52,
 "photo":"living","cover_id":"UUID ранее загруженной обложки"}
```

Метаданные необязательны: можно менять только фото. Пропуск cover_id сохраняет
обложку, null переключает на стандартную иллюстрацию photo (living / owner).
Устаревшая version — 409; чужая квартира скрыта. Ответ — обновлённая квартира;
полный снимок и защищённый URL фотографии перечитываются через GET /api/state.

Необязательный объект `lease` содержит id существующего периода и поля LeaseInput.
Разрешён только для active-черновика без участников и записей; проверяется заново
на сервере. Если жилец уже присоединился, сохранение lease отклоняется с 409.
Условия занятой аренды меняются существующим процессом `kind=terms`.

## Фото квартиры (0.2.0)

1. `POST /api/apartment-covers?name=photo.jpg` — сырые байты JPG/PNG/WebP,
   не multipart. Авторизованный собственник, X-Keys-Client. Не более 10 МБ,
   до 40 Мп и 20 000 px по стороне. Возвращает id, name, mime, size.
2. Передать id в cover_id создания или редактирования своей квартиры.
   Нельзя привязать чужое фото или фото другой квартиры.
3. GET /api/state возвращает cover_url текущей доступной обложки.
4. `POST /api/apartment-covers/:id/ticket` выдаёт `{url}` на 5 минут после
   проверки доступа (собственник либо текущий жилец).
5. `GET /api/apartment-covers/:id/image?ticket=...` — изображение inline,
   private/no-store, nosniff. Сам билет не отменяет проверку доступа/актуальности.
   Предыдущее фото после замены и доступ бывшего жильца отклоняются.

Непривязанную загрузку видит только загрузивший владелец. Выбор фото до кнопки
«Сохранить» не меняет существующую карточку. Квота всех обложек — 500 МБ / 500
файлов на аккаунт; очистка неактуальных загрузок после 24 часов. Временные URL
не логировать и не публиковать; JSON-экспорт не содержит подписанных ссылок.


## Дополнение 0.3.0 — авторитетный контракт новых возможностей

Статусы/payload описанные выше читаются с учётом этих изменений. Авторитетный
серверный список — route declarations в server/http.mjs; business — domain.mjs.

GET /api/state дополнительно возвращает units, leases[].tenant_ids/unit_title/
meters_enabled/current_rent/current_terms/current_due_day, meter_history, recurring_rules
с revisions[] и next_editable_month. tenant_id — только legacy, не проверка прав.

POST /api/apartments: прежние поля + rental_mode="whole"|"rooms", unit_title,
recurring_rent:boolean, meters_enabled:boolean. Плата — за весь объект.
POST /api/apartments/:id/units: {title,kind:"room"} → созданная комната.
POST /api/units/:id: {title,version} → изменение названия владельцем.
POST /api/apartments/:id/leases: прежние условия + unit_id; several tenants присоединяются
позже отдельными приглашениями, не массивом неподтверждённых аккаунтов из формы.
POST /api/leases/:id/archive-draft: {} — только пустая аренда без участников и записей.

POST /api/leases/:id/invite: {} → {code,expires,url}; url ведёт в Bot через start=join_.
POST /api/join: {code} — только demo/test; production принимает приглашение через Bot.

POST /api/leases/:id/meters:
{label,kind:"cold_water"|"hot_water"|"gas"|"electricity"|"heating"|"other",
 unit:"м³"|"кВт·ч"|"Гкал"|"МВт·ч"|"л"|"ед.", scope:"lease"|"apartment",
 baseline:0, scheme:"single"|"dual"|"triple"}
→ {meters:[...]} — один или несколько созданных тарифных каналов.
POST /api/meters/:id: {version,label?,baseline?,active?:boolean}; baseline в тысячных;
изменение initial запрещено после первого meter_value.
POST /api/leases/:id/meter-settings: {enabled:boolean}.
POST /api/records с reading: {values:[{meter_id,value}]} в payload. value — накопительные
целые тысячные, не расход. Уже переданные каналы за месяц не присылаются повторно.

POST /api/recurring-rules:
{lease_id,title,amount,due_day,advance_days,start_month,end_month?}.
POST /api/recurring-rules/:id:
{version,effective_month,title?,amount?,due_day?,advance_days?} для будущих изменений;
{version,action:"pause"|"delete"}; {version,action:"resume",effective_month?}.
Правила получают state active/paused/deleted. Удалённые скрыты из state, счета сохраняются.
Дни 1–31, advance1–60; month ISOYYYY-MM. UI показывает ММ.ГГГГ и переводит в ISO.

Charge payload: claims[] — {id,user_id,amount,note,at}, payments[] — подтверждённые
переводы с confirmed_by/confirmed_at; confirmed — общая подтверждённая сумма.
Поле claim — совместимое зеркало первого claim. confirm/reject принимает claim_id,
при одном claim допускается его однозначное разрешение сервером. Версия обязательна.
Visit/terms/termination содержат required_approvals[], accepted_by[].

GET /privacy и GET /terms — публичный HTML, не JSON, не требуют токена и не являются
API-авторизацией. Содержимое юридических страниц из исходного контекста не изменялось.


## Знакомство с приложением — 0.3.4

`POST /api/profile/guide` (авторизованный запрос с обычными Origin, X-Keys-Client
и Idempotency-Key) принимает:

```json
{"role":"owner","progress":{"opens":2,"topics":["documents","finances"],"dismissed":false}}
```

Открытия: целое 0–4. Topics: уникальные идентификаторы apartments, documents,
finances, requests, meters, purchases, visits. Dismissed: boolean. Ответ —
`{role, progress}` с объединённым значением. Счётчик объединяется через максимум,
темы — как множество, скрытие — логическим OR. Данные сохраняются в
`users.settings.guide_v1[role]` только для авторизованного пользователя.
Другие настройки и активная роль не перезаписываются; тело не принимает чужой user_id.

Это не аналитика действий: хранятся только ограниченный счётчик, набор разделов и
флаг скрытия. В клиенте локальный кэш разделён по ID пользователя и роли.
При недоступности сервера гайд не блокирует работу; локальный прогресс повторно
синхронизируется при следующем входе или событии online.

## Удаление квартиры (0.3.6)

`GET /api/apartments/:id/deletion-preview` — только собственник в режиме owner.
Возвращает название, адрес, version, can_delete, blockers, counts и
confirmation_token. Это read-only запрос, не удаляющий и не архивирующий данные.

`POST /api/apartments/:id/delete`:
```json
{"version": 1, "confirmation_token": "<значение из свежего preview>", "confirmed": true}
```

Требуются обычная сессия, X-Keys-Client и Idempotency-Key. Контрольное значение
проверяет снимок квартиры и всех связанных сущностей. При изменении после
предварительного просмотра — 409; интерфейс обязан запросить новый просмотр и
новое подтверждение. Активные жильцы и неурегулированные расчёты также дают 409.

Успех: `{"ok":true,"id":"...","deleted":true}`. Служебные storage_key клиенту
не возвращаются. Квартира, комнаты, аренды, записи, счётчики, файлы и привязанные
уведомления удаляются транзакционно. Очистка содержимого uploads — после commit.
Резервные копии, другие квартиры, аккаунты и настройки не удаляются. Приложение
не удаляет уже доставленные в MAX сообщения. Повтор одного запроса с тем же
ключом идемпотентен; новый ключ для уже удалённого объекта — 404.
