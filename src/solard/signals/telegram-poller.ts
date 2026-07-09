import { setTimeout as delay } from "node:timers/promises";
import { createSolardAppServices } from "../app-services.js";
import { measureSolard, summarizeForMeasure } from "../api-response.js";

const CURSOR_KEY = "signals:telegram:update-offset:v1";

type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id?: number;
    date?: number;
    chat?: { id: number; type?: string; title?: string; username?: string };
    from?: {
      id: number;
      is_bot?: boolean;
      first_name?: string;
      username?: string;
    };
    text?: string;
    caption?: string;
  };
  channel_post?: TelegramUpdate["message"];
  edited_message?: TelegramUpdate["message"];
};

function token(): string {
  const value =
    process.env.SOLARD_TELEGRAM_BOT_TOKEN?.trim() ||
    process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!value)
    throw new Error(
      "SOLARD_TELEGRAM_BOT_TOKEN or TELEGRAM_BOT_TOKEN is required",
    );
  return value;
}

function apiBase(): string {
  return (
    process.env.SOLARD_TELEGRAM_API_BASE_URL || "https://api.telegram.org"
  ).replace(/\/+$/, "");
}

function getCursor(app: ReturnType<typeof createSolardAppServices>): number {
  const row = app.sowl.db.settings
    .select()
    .where({ key: CURSOR_KEY })
    .first() as { value?: string } | undefined;
  const parsed = Number(row?.value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function setCursor(
  app: ReturnType<typeof createSolardAppServices>,
  value: number,
): void {
  const existing = app.sowl.db.settings
    .select()
    .where({ key: CURSOR_KEY })
    .first() as { value?: string; updatedAtMs?: number } | undefined;
  if (existing) {
    existing.value = String(value);
    existing.updatedAtMs = Date.now();
  } else {
    app.sowl.db.settings.insert({
      key: CURSOR_KEY,
      value: String(value),
      updatedAtMs: Date.now(),
    });
  }
}

function messageFrom(update: TelegramUpdate): TelegramUpdate["message"] | null {
  return update.message ?? update.channel_post ?? update.edited_message ?? null;
}

function sourceName(msg: NonNullable<TelegramUpdate["message"]>): string {
  const chat = msg.chat;
  if (!chat) return "Telegram";
  return (
    chat.title || (chat.username ? `@${chat.username}` : `chat:${chat.id}`)
  );
}

function rawFor(
  update: TelegramUpdate,
  msg: NonNullable<TelegramUpdate["message"]>,
) {
  return {
    updateId: update.update_id,
    messageId: msg.message_id ?? null,
    chat: msg.chat ?? null,
    from: msg.from ?? null,
    date: msg.date ?? null,
    source: "telegram-poller",
  };
}

async function telegramGetUpdates(
  offset: number,
  timeoutSeconds: number,
): Promise<TelegramUpdate[]> {
  const response = await fetch(`${apiBase()}/bot${token()}/getUpdates`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      offset: offset > 0 ? offset : undefined,
      timeout: timeoutSeconds,
      allowed_updates: ["message", "channel_post", "edited_message"],
    }),
  });
  const payload = (await response.json()) as {
    ok?: boolean;
    result?: TelegramUpdate[];
    description?: string;
  };
  if (!response.ok || !payload.ok) {
    throw new Error(
      payload.description ||
        `Telegram getUpdates failed: HTTP ${response.status}`,
    );
  }
  return payload.result ?? [];
}

export async function pollTelegramSignalsOnce(
  args: { timeoutSeconds?: number } = {},
) {
  const app = createSolardAppServices();
  try {
    const offset = getCursor(app);
    const updates = await telegramGetUpdates(
      offset,
      Math.max(0, Math.min(30, args.timeoutSeconds ?? 0)),
    );
    let nextOffset = offset;
    let ingested = 0;
    for (const update of updates) {
      nextOffset = Math.max(nextOffset, Number(update.update_id ?? 0) + 1);
      const msg = messageFrom(update);
      if (!msg || msg.from?.is_bot) continue;
      const text = (msg.text || msg.caption || "").trim();
      if (!text) continue;
      const state = app.signals.upsertSource({
        id: msg.chat?.id != null ? `telegram:${msg.chat.id}` : undefined,
        name: sourceName(msg),
        chatRef: msg.chat?.id != null ? String(msg.chat.id) : null,
        kind: "telegram",
        isActive: true,
      });
      const sourceId =
        msg.chat?.id != null
          ? `telegram:${msg.chat.id}`
          : (state.sources[0]?.id ?? null);
      app.signals.ingest({ sourceId, text, raw: rawFor(update, msg) });
      ingested += 1;
    }
    if (nextOffset !== offset) setCursor(app, nextOffset);
    return { updates: updates.length, ingested, offset: nextOffset };
  } finally {
    app.close();
  }
}

export async function listenTelegramSignals(
  args: {
    pollMs?: number;
    timeoutSeconds?: number;
    signal?: AbortSignal | null;
    onStatus?: (status: unknown) => void | Promise<void>;
  } = {},
): Promise<void> {
  const pollMs = Math.max(250, Math.min(30_000, Number(args.pollMs ?? 1_000)));
  const timeoutSeconds = Math.max(
    1,
    Math.min(30, Number(args.timeoutSeconds ?? 20)),
  );
  await args.onStatus?.({
    status: "listening",
    source: "telegram",
    pollMs,
    timeoutSeconds,
  });
  while (!args.signal?.aborted) {
    try {
      const measured = await measureSolard(
        "solard:signals:telegram",
        "pollTelegramSignalsOnce",
        () => pollTelegramSignalsOnce({ timeoutSeconds }),
        {
          result: summarizeForMeasure,
          onError: summarizeForMeasure,
          meta: { timeoutSeconds },
        },
      );
      if ((measured.value as { updates?: number }).updates) {
        await args.onStatus?.({
          status: "telegram-updates",
          ...(measured.value as object),
        });
      }
    } catch (error) {
      await args.onStatus?.({
        status: "telegram-error",
        error: error instanceof Error ? error.message : String(error),
      });
      await delay(Math.max(2_000, pollMs));
      continue;
    }
    try {
      await delay(pollMs, undefined, { signal: args.signal ?? undefined });
    } catch {
      break;
    }
  }
}
