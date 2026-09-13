import { mkdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { BrowserContext } from "playwright-core";

const PORT = Number(process.env.PORT ?? 3000);
const HOLIDAYS_URL = "https://kakoysegodnyaprazdnik.ru/";
const PROFILE_DIR = process.env.SCRAPER_PROFILE_DIR ?? "/tmp/holiday-scraper-profile";
const REQUEST_TIMEOUT_MS = 30_000;

interface HolidayResult {
  date: string;
  holidays: string[];
}

class ScraperError extends Error {
  constructor(
    message: string,
    readonly detail:
      | "cloudflare_challenge"
      | "regional_block"
      | "timeout"
      | "parse_error"
      | "upstream_error",
  ) {
    super(message);
  }
}

let contextPromise: Promise<BrowserContext> | undefined;
let requestLock = Promise.resolve();

function parseHolidayText(text: string, date: string): HolidayResult {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const holidays = [
    ...new Set(
      lines.filter(
        (line) =>
          line.length >= 4 &&
          line.length <= 180 &&
          !/^(меню|подписаться|войти|главная|новости|реклама|сегодня)$/i.test(line) &&
          /праздник|день|торжеств|памят|событ/i.test(line) &&
          !/какой сегодня праздник|праздники сегодня/i.test(line),
      ),
    ),
  ];
  if (holidays.length === 0) throw new Error("На странице не найден список праздников");
  return { date, holidays };
}

async function getBrowserContext(): Promise<BrowserContext> {
  if (!contextPromise) {
    contextPromise = (async () => {
      const [{ default: chromium }, { chromium: playwrightChromium }] = await Promise.all([
        import("@sparticuz/chromium"),
        import("playwright-core"),
      ]);
      await mkdir(PROFILE_DIR, { recursive: true });
      const executablePath = await chromium.executablePath();
      const proxyServer = process.env.SCRAPER_PROXY_SERVER;
      const proxyUsername = process.env.SCRAPER_PROXY_USERNAME;
      const proxyPassword = process.env.SCRAPER_PROXY_PASSWORD;
      const proxy = proxyServer
        ? {
            server: proxyServer,
            ...(proxyUsername ? { username: proxyUsername } : {}),
            ...(proxyPassword ? { password: proxyPassword } : {}),
          }
        : undefined;
      console.info("Holiday browser starting", {
        executablePath,
        profileDir: PROFILE_DIR,
        proxyConfigured: Boolean(proxyServer),
      });
      if (!proxyServer) {
        console.info("Holiday scraper using direct connection; no proxy configured");
      }
      return playwrightChromium.launchPersistentContext(PROFILE_DIR, {
        args: chromium.args,
        executablePath,
        headless: true,
        locale: "ru-RU",
        viewport: { width: 1280, height: 900 },
        userAgent:
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
        extraHTTPHeaders: {
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
        },
        ...(proxy ? { proxy } : {}),
      });
    })().catch((error) => {
      contextPromise = undefined;
      throw error;
    });
  }
  return contextPromise;
}

async function scrapeToday(): Promise<HolidayResult> {
  const context = await getBrowserContext();
  const page = await context.newPage();
  try {
    const navigation = await page.goto(HOLIDAYS_URL, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    console.info("Holiday page loaded", {
      status: navigation?.status() ?? null,
      url: page.url(),
      title: await page.title(),
    });
    if (navigation?.status() === 403 || navigation?.status() === 451) {
      throw new ScraperError(
        `Источник отклонил запрос (HTTP ${navigation.status()})`,
        "regional_block",
      );
    }
    const challengeButton = page.locator("#cont");
    if (await challengeButton.count()) {
      console.info("Holiday site security challenge detected");
      await page.waitForTimeout(2_000);
      if (await challengeButton.isVisible()) {
        await challengeButton.click({ timeout: 5_000 });
        await page.waitForTimeout(2_000);
      }
    }
    const bodyText = await page.locator("body").innerText();
    console.info("Holiday page text collected", {
      characters: bodyText.length,
      preview: bodyText.slice(0, 200),
    });
    if (/проверка безопасности|enable javascript|captcha/i.test(bodyText)) {
      throw new ScraperError("Сайт запросил проверку безопасности", "cloudflare_challenge");
    }
    const structuredText = await page
      .locator("h1, h2, h3, h4, li, article p, .holiday, .holidays")
      .allInnerTexts();
    const date = new Intl.DateTimeFormat("ru-RU", {
      dateStyle: "long",
      timeZone: "Europe/Moscow",
    }).format(new Date());
    return parseHolidayText([...structuredText, bodyText].join("\n"), date);
  } finally {
    await page.close();
  }
}

function authorized(request: IncomingMessage): boolean {
  const expected = process.env.SCRAPER_API_KEY;
  const supplied = request.headers["x-api-key"] ?? request.headers.authorization?.replace(/^Bearer\s+/i, "");
  return Boolean(expected && supplied === expected);
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

function handler(request: IncomingMessage, response: ServerResponse): void {
  const path = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`).pathname;
  if (request.method === "GET" && path === "/health") {
    // Keep health independent from Chromium so Render can probe it during startup.
    json(response, 200, { ok: true, uptimeSeconds: Math.floor(process.uptime()) });
    return;
  }
  if ((request.method !== "GET" && request.method !== "POST") || path !== "/today") {
    json(response, 404, { error: "Not Found" });
    return;
  }
  if (!authorized(request)) {
    json(response, 401, { error: "Unauthorized" });
    return;
  }

  requestLock = requestLock.then(async () => {
    try {
      const result = await Promise.race([
        scrapeToday(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new ScraperError("Scraper request timed out", "timeout")),
            REQUEST_TIMEOUT_MS,
          ),
        ),
      ]);
      json(response, 200, result);
    } catch (error) {
      console.error("Holiday scraper request failed", error);
      const detail =
        error instanceof ScraperError
          ? error.detail
          : error instanceof Error && /parse|праздник/i.test(error.message)
            ? "parse_error"
            : "upstream_error";
      json(response, 502, {
        error: "Holiday scraper unavailable",
        detail,
        fallback: "retry_later",
      });
    }
  });
}

const server = createServer(handler);
server.on("error", (error) => {
  console.error("Holiday scraper server failed", error);
  process.exitCode = 1;
});
server.listen(PORT, "0.0.0.0", () => {
  console.info(`Holiday scraper listening on ${PORT}`);
});
