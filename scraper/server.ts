import { mkdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import chromium from "@sparticuz/chromium";
import { type BrowserContext, chromium as playwrightChromium } from "playwright-core";

const PORT = Number(process.env.PORT ?? 3000);
const HOLIDAYS_URL = "https://kakoysegodnyaprazdnik.ru/";
const PROFILE_DIR = process.env.SCRAPER_PROFILE_DIR ?? "/tmp/holiday-scraper-profile";
const REQUEST_TIMEOUT_MS = 30_000;

interface HolidayResult {
  date: string;
  holidays: string[];
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
      await mkdir(PROFILE_DIR, { recursive: true });
      const executablePath = await chromium.executablePath();
      console.info("Holiday browser starting", { executablePath, profileDir: PROFILE_DIR });
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
      throw new Error("Сайт запросил проверку безопасности");
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
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function handler(request: IncomingMessage, response: ServerResponse): void {
  const path = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`).pathname;
  if (request.method === "GET" && path === "/health") {
    json(response, 200, { ok: true });
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
          setTimeout(() => reject(new Error("Scraper request timed out")), REQUEST_TIMEOUT_MS),
        ),
      ]);
      json(response, 200, result);
    } catch (error) {
      console.error("Holiday scraper request failed", error);
      json(response, 502, { error: "Holiday scraper unavailable" });
    }
  });
}

createServer(handler).listen(PORT, "0.0.0.0", () => {
  console.info(`Holiday scraper listening on ${PORT}`);
});
