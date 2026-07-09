#!/usr/bin/env bun
import {
  getCursor,
  setCursor,
  upsertProcessStatus,
  upsertTelegramSignal,
} from "../db/terminal-store.js";
import {
  workerMeasure,
  measureRetry,
  summarizeForMeasure,
} from "../measure.js";

const NAME = "solard-telegram-signals";
const POLL_MS = Math.max(
  1000,
  Number(process.env.SOLARD_TELEGRAM_POLL_MS ?? "1500"),
);
const BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN || process.env.SOLARD_TELEGRAM_BOT_TOKEN || "";
const API_BASE = (
  process.env.TELEGRAM_BOT_API_BASE_URL || "https://api.telegram.org"
).replace(/\/+$/, "");

const MINT_RE =
  /\b[1-9A-HJ-NP-Za-km-z]{32,44}pump\b|\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const SYMBOL_RE = /\$([A-Za-z][A-Za-z0-9_]{1,15})\b/g;
const URL_RE = /https?:\/\/\S+/g;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function parseText(text: string): {
  mints: string[];
  symbols: string[];
  urls: string[];
} {
  const urls = unique(text.match(URL_RE) ?? []);
  const symbols = unique(
    Array.from(text.matchAll(SYMBOL_RE)).map((m) => m[1]!),
  );
  const directMints = text.match(MINT_RE) ?? [];
  const urlMints = urls.flatMap((url) => url.match(MINT_RE) ?? []);
  return { mints: unique([...directMints, ...urlMints]), symbols, urls };
}

function telegramUrl(method: string): string {
  if (!BOT_TOKEN)
    throw new Error("Missing TELEGRAM_BOT_TOKEN/SOLARD_TELEGRAM_BOT_TOKEN");
  return `${API_BASE}/bot${BOT_TOKEN}/${method}`;
}

async function telegram(
  method: string,
  body: Record<string, unknown>,
): Promise<any> {
  const res = await fetch(telegramUrl(method), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await res.json();
  if (!res.ok || !payload.ok)
    throw new Error(
      payload.description || `Telegram ${method} failed ${res.status}`,
    );
  return payload.result;
}

async function tick(): Promise<Record<string, unknown>> {
  return await workerMeasure.measure(
    {
      start: () => "telegram signals poll",
      end: (result) => ({ result: summarizeForMeasure(result) }),
      catch: (error) => {
        upsertProcessStatus({
          name: NAME,
          kind: "signals",
          status: "error",
          error,
        });
        throw error;
      },
    },
    async () => {
      const offset = Number(getCursor(`${NAME}:offset`) || "0") || undefined;
      const updates = await measureRetry(
        "telegram getUpdates",
        { attempts: 3, delay: 250, backoff: 2 },
        () =>
          telegram("getUpdates", {
            offset,
            timeout: 25,
            allowed_updates: ["message", "channel_post"],
          }),
      );
      let ingested = 0;
      let maxOffset = offset ?? 0;
      for (const update of updates ?? []) {
        maxOffset = Math.max(maxOffset, Number(update.update_id || 0) + 1);
        const msg = update.message ?? update.channel_post;
        if (!msg) continue;
        const text = String(msg.text ?? msg.caption ?? "").trim();
        if (!text) continue;
        const parsed = parseText(text);
        if (!parsed.mints.length && !parsed.symbols.length) continue;
        upsertTelegramSignal({
          id: `tg:${update.update_id}`,
          sourceName: msg.chat?.title || msg.chat?.username || "telegram",
          chatRef: msg.chat?.username
            ? `@${msg.chat.username}`
            : String(msg.chat?.id ?? ""),
          text,
          mints: parsed.mints,
          symbols: parsed.symbols,
          urls: parsed.urls,
          raw: update,
          receivedAtMs: Number(msg.date ? msg.date * 1000 : Date.now()),
        });
        ingested++;
      }
      if (maxOffset) setCursor(`${NAME}:offset`, String(maxOffset));
      upsertProcessStatus({
        name: NAME,
        kind: "signals",
        status: "ok",
        data: {
          updates: updates?.length ?? 0,
          ingested,
          offset: maxOffset,
          pollMs: POLL_MS,
        },
      });
      return { updates: updates?.length ?? 0, ingested, offset: maxOffset };
    },
  );
}

async function main(): Promise<void> {
  upsertProcessStatus({
    name: NAME,
    kind: "signals",
    status: "starting",
    data: { pollMs: POLL_MS },
  });
  while (true) {
    try {
      await tick();
    } catch (error) {
      upsertProcessStatus({
        name: NAME,
        kind: "signals",
        status: "error",
        error,
      });
      await sleep(Math.max(POLL_MS, 5000));
    }
    await sleep(POLL_MS);
  }
}

main().catch((error) => {
  upsertProcessStatus({ name: NAME, kind: "signals", status: "fatal", error });
  throw error;
});
