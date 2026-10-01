import type { VercelRequest, VercelResponse } from "@vercel/node";

const TELEGRAM_API = "https://api.telegram.org";
const SCRAPER_REQUEST_TIMEOUT_MS = 25_000;

interface TelegramUpdate {
  message?: {
    chat: { id: number };
    text?: string;
  };
}

interface HolidayResult {
  date: string;
  holidays: string[];
  source?: "scraper" | "local-calendar";
}

class ScraperApiError extends Error {
  constructor(readonly detail: string) {
    super(`Scraper API error: ${detail}`);
  }
}

function getLocalTodayHolidays(): HolidayResult {
  const now = new Date();
  const date = new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "long",
    timeZone: "Europe/Moscow",
  }).format(now);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const monthDay = `${values.month}-${values.day}`;
  const holidays: string[] = [];
  const fixedHolidays: Record<string, string> = {
    "01-01": "Новый год",
    "01-07": "Рождество Христово",
    "02-23": "День защитника Отечества",
    "03-08": "Международный женский день",
    "05-01": "Праздник Весны и Труда",
    "05-09": "День Победы",
    "06-12": "День России",
    "11-04": "День народного единства",
  };
  if (fixedHolidays[monthDay]) holidays.push(fixedHolidays[monthDay]);
  if (values.weekday === "Sat" || values.weekday === "Sun") {
    holidays.push("Выходной день");
  }
  if (holidays.length === 0) {
    holidays.push("Памятная дата или праздник не определены локальным календарём");
  }
  return { date, holidays, source: "local-calendar" };
}

async function getTodayHolidays(): Promise<HolidayResult> {
  const scraperUrl = process.env.SCRAPER_URL?.replace(/\/+$/, "");
  const scraperApiKey = process.env.SCRAPER_API_KEY;
  if (process.env.SCRAPER_FREE_MODE === "true" || !scraperUrl || !scraperApiKey) {
    console.info("Using free local calendar mode", {
      reason: process.env.SCRAPER_FREE_MODE === "true" ? "configured" : "scraper_not_configured",
    });
    return getLocalTodayHolidays();
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SCRAPER_REQUEST_TIMEOUT_MS);
  try {
    const scraperResponse = await fetch(`${scraperUrl}/today`, {
      headers: { "x-api-key": scraperApiKey },
      signal: controller.signal,
    });
    const body = await scraperResponse.text();
    if (!scraperResponse.ok) {
      let detail = "upstream_error";
      try {
        const parsed = JSON.parse(body) as {
          detail?: unknown;
          errorName?: unknown;
          errorMessage?: unknown;
        };
        if (typeof parsed.detail === "string") detail = parsed.detail;
        console.error("Scraper API diagnostic", {
          detail,
          errorName: typeof parsed.errorName === "string" ? parsed.errorName : "unknown",
          errorMessage:
            typeof parsed.errorMessage === "string"
              ? parsed.errorMessage.slice(0, 200)
              : "unknown",
        });
      } catch {
        console.error("Scraper API returned non-JSON error body");
      }
      console.error("Scraper API error", {
        status: scraperResponse.status,
        detail,
        bodyLength: body.length,
      });
      throw new ScraperApiError(detail);
    }

    const result = JSON.parse(body) as HolidayResult;
    if (!result.date || !Array.isArray(result.holidays) || result.holidays.length === 0) {
      throw new Error("Scraper API вернул некорректный список праздников");
    }
    return result;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      console.warn("Scraper request timed out", {
        timeoutMs: SCRAPER_REQUEST_TIMEOUT_MS,
      });
      throw new Error("Scraper request timed out");
    }
    console.error("Scraper request failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    throw error;
  } finally {
    clearTimeout(timeout);
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
        `${result.source === "local-calendar" ? "Локальный бесплатный режим (без парсинга сайта)\n" : ""}Праздники на ${result.date}:\n\n${result.holidays.map((holiday) => `• ${holiday}`).join("\n")}`,
      );
    }
  } catch (error) {
    console.error("Webhook processing failed", error);
    await sendTelegramMessage(
      message.chat.id,
      error instanceof ScraperApiError &&
      (error.detail === "cloudflare_challenge" || error.detail === "regional_block")
        ? "Источник праздников недоступен из текущего региона или запросил проверку безопасности. Настройте российский proxy для scraper или попробуйте позже."
        : "Не удалось получить праздники. Попробуйте еще раз позже.",
    );
  }

  response.status(200).json({ ok: true });
}
