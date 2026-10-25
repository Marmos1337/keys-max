Local Telegram launch check (not part of npm test).

    rm -rf /tmp/keys-tg && node tests/telegram-local/seed.mjs "$PWD" /tmp/keys-tg   # prints a link code
    APP_MODE=test PORT=3000 PUBLIC_URL=http://localhost:3000 DATA_DIR=/tmp/keys-tg \
      SESSION_SECRET=local-run-secret-local-run-secret-1234 \
      KEYS_TG_BOT_TOKEN=123456:local-test-token-abcdefghijklmnopqrstuv KEYS_TG_BOT_USERNAME=rentkeysbot \
      node server/index.mjs
    python run.py <link code>      # needs playwright + Google Chrome; screenshots go to ./shots

run.py signs launch data with the test token, injects a TelegramWebviewProxy that
records bridge events, and walks welcome → login → home → profile → messengers →
invite at 320/375/430 px in light and dark, then links a MAX account by code.
