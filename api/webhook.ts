import type { VercelRequest, VercelResponse } from "@vercel/node";
import chromium from "@sparticuz/chromium";
import { type Browser, chromium as playwrightChromium } from "playwright-core";

const HOLIDAYS_URL = "https://kakoysegodnyaprazdnik.ru/";
const TELEGRAM_API = "https://api.telegram.org";

interface TelegramUpdate {
  message?: {
    chat: { id: number };
    text?: string;
  };
}

interface HolidayResult {
  date: string;
  holidays: string[];
}

function parseHolidayText(text: string, date: string): HolidayResult {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const candidates = lines.filter((line) => {
    if (line.length < 4 || line.length > 180) return false;
    if (/^(меню|подписаться|войти|главная|новости|реклама|сегодня)$/i.test(line)) {
      return false;
    }
    return /праздник|день|торжеств|памят|событ/i.test(line);
  });

  const holidays = [...new Set(candidates)].filter(
    (line) => !/какой сегодня праздник|праздники сегодня/i.test(line),
  );

  if (holidays.length === 0) {
    throw new Error("На странице не найден список праздников");
  }

  return { date, holidays };
}

async function getTodayHolidays(): Promise<HolidayResult> {
  let browser: Browser | undefined;

  try {
    const executablePath = await chromium.executablePath();
    console.info("Holiday browser starting", { executablePath });
    browser = await playwrightChromium.launch({
      args: chromium.args,
      executablePath,
      headless: true,
    });

    const page = await browser.newPage({
      locale: "ru-RU",
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
    });
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
      url: page.url(),
      characters: bodyText.length,
      preview: bodyText.slice(0, 200),
    });
    if (/проверка безопасности|enable javascript|captcha/i.test(bodyText)) {
      throw new Error("Сайт запросил проверку безопасности");
    }

    const structuredText = await page
      .locator("h1, h2, h3, h4, li, article p, .holiday, .holidays")
      .allInnerTexts();
    const parsedText = [...structuredText, bodyText].join("\n");
    const date = new Intl.DateTimeFormat("ru-RU", {
      dateStyle: "long",
      timeZone: "Europe/Moscow",
    }).format(new Date());
    return parseHolidayText(parsedText, date);
  } catch (error) {
    console.error("Holiday scraper failed", error);
    throw error;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (error) {
        console.error("Holiday browser close failed", error);
      }
    }
  }
}

async function sendTelegramMessage(chatId: number, text: string): Promise<boolean> {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      console.error("Telegram API error", 0, "TELEGRAM_BOT_TOKEN не задан");
      return false;
    }

    const response = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    const body = await response.text();

    if (!response.ok) {
      console.error("Telegram API error", response.status, body);
      return false;
    }

    return true;
  } catch (error) {
    console.error("Telegram API request failed", error);
    return false;
  }
}

function helpMessage(): string {
  return [
    "Доступные команды:",
    "/today — праздники текущего дня",
    "/start — приветствие",
    "/help — эта справка",
  ].join("\n");
}

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
): Promise<void> {
  if (request.method !== "POST") {
    response.status(405).json({ error: "Method Not Allowed" });
    return;
  }

  const update = request.body as TelegramUpdate;
  const message = update?.message;
  if (!message?.chat?.id || !message.text) {
    response.status(200).json({ ok: true });
    return;
  }

  try {
    const command = message.text.trim().split(/\s+/)[0].toLowerCase();
    if (command === "/start") {
      await sendTelegramMessage(
        message.chat.id,
        "Привет! Я покажу праздники текущего дня. Используйте /today.",
      );
    } else if (command === "/help") {
      await sendTelegramMessage(message.chat.id, helpMessage());
    } else if (command === "/today") {
      const result = await getTodayHolidays();
      await sendTelegramMessage(
        message.chat.id,
        `Праздники на ${result.date}:\n\n${result.holidays.map((holiday) => `• ${holiday}`).join("\n")}`,
      );
    }
  } catch (error) {
    console.error("Webhook processing failed", error);
    await sendTelegramMessage(
      message.chat.id,
      "Не удалось получить праздники. Попробуйте еще раз позже.",
    );
  }

  response.status(200).json({ ok: true });
}
