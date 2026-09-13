# Telegram Holidays Bot

Telegram-бот на TypeScript/Node.js, который по команде `/today` получает праздники текущего дня с [kakoysegodnyaprazdnik.ru](https://kakoysegodnyaprazdnik.ru/). Chromium вынесен в отдельный HTTP-сервис `scraper/server.ts`, предназначенный для деплоя на Render. Vercel serverless function только вызывает этот сервис и не запускает браузер.

Сайт может отдавать Cloudflare/security challenge или блокировать автоматизированный браузер. Сервис переиспользует запущенный Chromium process между запросами, создаёт изолированный context на запрос, использует реалистичные заголовки и user-agent и логирует обнаружение challenge, но не гарантирует его обход.

## Деплой scraper на Render

1. Создайте новый Render Web Service из этого репозитория. Render обнаружит `Dockerfile` (или используйте `render.yaml`).
2. Задайте секретную переменную `SCRAPER_API_KEY` в настройках Render. Используйте длинное случайное значение; не добавляйте его в git.
3. Если источник доступен только из России, задайте в Render переменную `SCRAPER_PROXY_SERVER` с адресом российского HTTP(S)/SOCKS5 proxy. При необходимости добавьте `SCRAPER_PROXY_USERNAME` и `SCRAPER_PROXY_PASSWORD` как secret variables. Прокси не зашит в код; если `SCRAPER_PROXY_SERVER` пуст, scraper работает напрямую и пишет это в лог.
4. После деплоя проверьте публичный health endpoint:

   ```bash
   curl https://<scraper-домен>.onrender.com/health
   ```

   Ожидаемый ответ: `{"ok":true}`.
5. Проверьте защищённый endpoint:

   ```bash
   curl -H "x-api-key: <SCRAPER_API_KEY>" \
     https://<scraper-домен>.onrender.com/today
   ```

Render запускает Dockerfile на `0.0.0.0:$PORT`; сервис поддерживает `GET` и `POST /today`, `GET /health`.
`/health` не импортирует и не запускает Chromium и отвечает синхронно с HTTP 200, поэтому ошибки браузера не должны влиять на health check. Если публичный URL временно возвращает 503 сразу после периода без запросов, это cold start/sleep самого Render Free: инфраструктура ещё не запустила контейнер, и код приложения в этот момент не выполняется. Для постоянного health 200 используйте Starter или выше (в `render.yaml` указан `plan: starter`) и дождитесь завершения deploy; после пробуждения повторите запрос через 30–60 секунд.

Если сайт отдаёт Cloudflare/security challenge или отклоняет запрос по региону, `GET/POST /today` возвращает HTTP 502 с безопасным `detail: "cloudflare_challenge"` либо `"regional_block"` и `fallback: "retry_later"`. Ошибки запуска Chromium дополнительно содержат ограниченные `errorName`/`errorMessage` (до 200 символов), без HTML, токенов, proxy credentials и путей. Для региональной блокировки настройте `SCRAPER_PROXY_SERVER` на Render; бот не падает и не делает ложный ответ.

## Деплой на Vercel

1. Создайте бота в Telegram через [@BotFather](https://t.me/BotFather): `/newbot`, задайте имя и username, сохраните выданный токен.
2. Импортируйте репозиторий в Vercel и выберите Node.js проект.
3. В настройках Vercel добавьте `TELEGRAM_BOT_TOKEN`, `SCRAPER_URL` (например, `https://<scraper-домен>.onrender.com`) и тот же `SCRAPER_API_KEY`, который задан в Render. Настоящие значения не нужно добавлять в git.
4. Выполните деплой. Endpoint webhook будет доступен по адресу `https://<ваш-домен>.vercel.app/api/webhook`.
5. Установите webhook, подставив токен и домен:

   ```bash
   curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://<ваш-домен>.vercel.app/api/webhook"
   ```

6. Откройте чат с ботом и отправьте `/start`, `/help` или `/today`.

Проект настроен как API-only: `buildCommand: null` отключает запуск `npm run build` на Vercel, а `api/webhook.ts` распознается как serverless function по соглашению каталога `api`. Статический `outputDirectory` этому проекту не нужен.

## Локальная проверка

Требуется Node.js 20+:

```bash
npm install
cp .env.example .env
# замените значение TELEGRAM_BOT_TOKEN в .env
npm run typecheck
npm run build
```

Для локальной проверки scraper задайте `SCRAPER_API_KEY`, затем выполните `npm run build` и `PORT=3000 npm run start:scraper`. В другом терминале вызовите `curl -H "x-api-key: $SCRAPER_API_KEY" http://localhost:3000/today`. Для проверки webhook запустите `vercel dev`, задайте `SCRAPER_URL=http://localhost:3000` и используйте туннель (например, ngrok), указав Telegram URL вида `https://<туннель>/api/webhook` через `setWebhook`.

Бот намеренно не хранит подписчиков и не выполняет рассылку: он отвечает только на входящие команды.
