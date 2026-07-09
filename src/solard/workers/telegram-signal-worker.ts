#!/usr/bin/env bun
import {
  getCursor,
  setCursor,
  upsertProcessStatus,
} from "../db/terminal-store.js";
import {
  workerMeasure,
  measureRetry,
  summarizeForMeasure,
} from "../measure.js";
import {
  parseTerminalSignalText,
  projectSignalToTerminal,
} from "../signals/terminal-projection.js";

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
const ALLOWED_UPDATES = ["message", "channel_post"];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function chatRef(msg: any): string | null {
  const chat = msg?.chat;
  if (!chat) return null;
  const title = chat.title || chat.username || chat.first_name || "telegram";
  return `${title}:${chat.id}`;
}

function sourceName(msg: any): string {
  const chat = msg?.chat;
  return String(
    chat?.title || chat?.username || chat?.first_name || "telegram",
  );
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
        "telegram signals getUpdates",
        { attempts: 3, delay: 250, backoff: 2 },
        () =>
          telegram("getUpdates", {
            offset,
            timeout: 25,
            allowed_updates: ALLOWED_UPDATES,
          }),
      );

      let ingested = 0;
      let projectedTokens = 0;
      let maxOffset = offset ?? 0;

      for (const update of updates ?? []) {
        maxOffset = Math.max(maxOffset, Number(update.update_id || 0) + 1);
        const msg = update.message ?? update.channel_post;
        if (!msg) continue;
        const text = String(msg.text ?? msg.caption ?? "").trim();
        if (!text) continue;

        const parsed = parseTerminalSignalText(text, update);
        if (
          !parsed.mints.length &&
          !parsed.symbols.length &&
          !parsed.urls.length
        )
          continue;

        const projection = await projectSignalToTerminal({
          id: `telegram:${update.update_id}`,
          sourceId: String(msg.chat?.id ?? "telegram"),
          sourceName: sourceName(msg),
          chatRef: chatRef(msg),
          text,
          raw: update,
          receivedAtMs:
            Number(msg.date || 0) > 0 ? Number(msg.date) * 1000 : Date.now(),
        });
        ingested++;
        projectedTokens += Number(projection.projectedTokens ?? 0);
      }

      if (maxOffset) setCursor(`${NAME}:offset`, String(maxOffset));
      upsertProcessStatus({
        name: NAME,
        kind: "signals",
        status: "ok",
        data: {
          offset: maxOffset,
          updates: updates?.length ?? 0,
          ingested,
          projectedTokens,
          pollMs: POLL_MS,
        },
      });
      return {
        updates: updates?.length ?? 0,
        ingested,
        projectedTokens,
        offset: maxOffset,
      };
    },
  );
}

async function main(): Promise<void> {
  if (!BOT_TOKEN) {
    upsertProcessStatus({
      name: NAME,
      kind: "signals",
      status: "disabled",
      data: { reason: "missing telegram bot token" },
    });
    return;
  }

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

await main();
