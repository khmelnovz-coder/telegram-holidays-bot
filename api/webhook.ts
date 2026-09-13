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
}

class ScraperApiError extends Error {
  constructor(readonly detail: string) {
    super(`Scraper API error: ${detail}`);
  }
}

async function getTodayHolidays(): Promise<HolidayResult> {
  const scraperUrl = process.env.SCRAPER_URL?.replace(/\/+$/, "");
  const scraperApiKey = process.env.SCRAPER_API_KEY;
  if (!scraperUrl || !scraperApiKey) {
    throw new Error("SCRAPER_URL или SCRAPER_API_KEY не заданы");
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
      console.error("Scraper API error", scraperResponse.status, body);
      let detail = "upstream_error";
      try {
        const parsed = JSON.parse(body) as { detail?: unknown };
        if (typeof parsed.detail === "string") detail = parsed.detail;
      } catch {
        console.error("Scraper API returned non-JSON error body");
      }
      throw new ScraperApiError(detail);
    }

    const result = JSON.parse(body) as HolidayResult;
    if (!result.date || !Array.isArray(result.holidays) || result.holidays.length === 0) {
      throw new Error("Scraper API вернул некорректный список праздников");
    }
    return result;
  } catch (error) {
    console.error("Scraper request failed", error);
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
        `Праздники на ${result.date}:\n\n${result.holidays.map((holiday) => `• ${holiday}`).join("\n")}`,
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
