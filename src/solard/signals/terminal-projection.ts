import { createMeasure, summarizeForMeasure } from "../measure.js";
import {
  upsertTelegramSignal,
  upsertTerminalToken,
  recomputeTerminalIndicators,
  listTelegramSignals,
} from "../db/terminal-store.js";

const signalMeasure = createMeasure("solard:signals");

const MINT_RE =
  /\b[1-9A-HJ-NP-Za-km-z]{32,44}pump\b|\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const SYMBOL_RE = /\$([A-Za-z][A-Za-z0-9_]{1,15})\b/g;
const URL_RE = /https?:\/\/\S+/g;
const PUMP_URL_MINT_RE =
  /(?:pump\.fun|pumpfun|dexscreener\.com\/solana|birdeye\.so\/token)\S*?([1-9A-HJ-NP-Za-km-z]{32,44}(?:pump)?)/gi;

export type ParsedTerminalSignal = {
  text: string;
  mints: string[];
  symbols: string[];
  urls: string[];
};

export type TerminalSignalProjectionInput = {
  id?: string | null;
  sourceId?: string | null;
  sourceName?: string | null;
  chatRef?: string | null;
  text: string;
  raw?: Record<string, unknown> | null;
  receivedAtMs?: number;
};

function unique(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean)),
  );
}

function rawTextFromValue(value: unknown): string[] {
  if (value == null) return [];
  if (typeof value === "string") return [value];
  if (typeof value === "number" || typeof value === "boolean") return [];
  if (Array.isArray(value)) return value.flatMap(rawTextFromValue);
  if (typeof value === "object") {
    const input = value as Record<string, unknown>;
    const preferred = [
      input.text,
      input.caption,
      input.message,
      input.body,
      input.description,
      input.url,
      input.uri,
      input.mint,
      input.address,
    ];
    return [...preferred.flatMap(rawTextFromValue)];
  }
  return [];
}

export function parseTerminalSignalText(
  text: string,
  raw?: Record<string, unknown> | null,
): ParsedTerminalSignal {
  const combinedText = unique([text, ...rawTextFromValue(raw)]).join("\n");
  const urls = unique(combinedText.match(URL_RE) ?? []);
  const symbols = unique(
    Array.from(combinedText.matchAll(SYMBOL_RE)).map((match) => match[1]),
  );
  const directMints = combinedText.match(MINT_RE) ?? [];
  const pumpUrlMints = Array.from(combinedText.matchAll(PUMP_URL_MINT_RE)).map(
    (match) => match[1],
  );
  const urlMints = urls.flatMap((url) => url.match(MINT_RE) ?? []);
  return {
    text,
    mints: unique([...directMints, ...pumpUrlMints, ...urlMints]),
    symbols,
    urls,
  };
}

function projectionId(
  input: TerminalSignalProjectionInput,
  parsed: ParsedTerminalSignal,
): string {
  if (input.id) return input.id;
  const basis = `${input.sourceId ?? "signal"}:${input.receivedAtMs ?? Date.now()}:${parsed.mints.join(",")}:${input.text.slice(0, 64)}`;
  let hash = 2166136261;
  for (let i = 0; i < basis.length; i++) {
    hash ^= basis.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `signal:${(hash >>> 0).toString(36)}:${input.receivedAtMs ?? Date.now()}`;
}

export async function projectSignalToTerminal(
  input: TerminalSignalProjectionInput,
): Promise<Record<string, unknown>> {
  return await signalMeasure.measure(
    {
      start: () => "project signal to terminal",
      end: (result) => ({ result: summarizeForMeasure(result) }),
    },
    async () => {
      const parsed = parseTerminalSignalText(input.text, input.raw);
      const id = projectionId(input, parsed);
      const receivedAtMs = input.receivedAtMs ?? Date.now();
      const row = upsertTelegramSignal({
        id,
        sourceId: input.sourceId ?? null,
        sourceName: input.sourceName ?? null,
        chatRef: input.chatRef ?? null,
        text: input.text,
        mints: parsed.mints,
        symbols: parsed.symbols,
        urls: parsed.urls,
        raw: input.raw ?? null,
        receivedAtMs,
      });

      const symbol = parsed.symbols[0] ?? "";
      for (const mint of parsed.mints) {
        upsertTerminalToken({
          mint,
          symbol,
          name: symbol || "telegram signal",
          source: "telegram-signal",
          updatedAtMs: receivedAtMs,
        });
        recomputeTerminalIndicators(mint, receivedAtMs);
      }

      return {
        id: row.id,
        mints: parsed.mints,
        symbols: parsed.symbols,
        urls: parsed.urls,
        projectedTokens: parsed.mints.length,
      };
    },
  );
}

export function listProjectedSignals(limit = 100): Record<string, unknown>[] {
  return signalMeasure.measureSync(
    {
      start: () => "list projected signals",
      end: (rows) => ({ rows: rows.length }),
    },
    () => listTelegramSignals(limit),
  );
}
