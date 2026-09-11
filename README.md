# Telegram Holidays Bot

Telegram-бот на TypeScript/Node.js, который по команде `/today` получает праздники текущего дня с [kakoysegodnyaprazdnik.ru](https://kakoysegodnyaprazdnik.ru/). Обход возможного 403 выполняется в браузере Chromium через `playwright-core` и `@sparticuz/chromium`; постоянный процесс не используется.

## Деплой на Vercel

1. Создайте бота в Telegram через [@BotFather](https://t.me/BotFather): `/newbot`, задайте имя и username, сохраните выданный токен.
2. Импортируйте репозиторий в Vercel и выберите Node.js проект.
3. В настройках Vercel добавьте переменную окружения `TELEGRAM_BOT_TOKEN` со значением из BotFather. Настоящий токен не нужно добавлять в git.
4. Выполните деплой. Endpoint webhook будет доступен по адресу `https://<ваш-домен>.vercel.app/api/webhook`.
5. Установите webhook, подставив токен и домен:

   ```bash
   curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://<ваш-домен>.vercel.app/api/webhook"
   ```

6. Откройте чат с ботом и отправьте `/start`, `/help` или `/today`.

## Локальная проверка

Требуется Node.js 20+:

```bash
npm install
cp .env.example .env
# замените значение TELEGRAM_BOT_TOKEN в .env
npm run typecheck
npm run build
```

Для проверки webhook локально запустите `vercel dev`, затем используйте туннель (например, ngrok) и укажите Telegram URL вида `https://<туннель>/api/webhook` через `setWebhook`. Команда `/today` запускает Chromium в рамках одного запроса и закрывает браузер после парсинга.

Бот намеренно не хранит подписчиков и не выполняет рассылку: он отвечает только на входящие команды.
