import { Connection, PublicKey } from "@solana/web3.js";
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
import { resolveSolUsd } from "../prices/sol-usd.js";
import {
  PUMPFUN_PROGRAM_ID,
  parsePumpTransaction,
} from "../helius/pump-transaction.js";
import { applyParsedPumpTransaction } from "../helius/apply-pump-parsed.js";

const WORKER = "solard-helius-live-v2";
const BUILD_ID = "helius-live-v7-alt-safe-parser";
const POLL_MS = Math.max(
  500,
  Number(process.env.SOLARD_HELIUS_POLL_MS ?? "1500"),
);
const LIMIT = Math.max(
  1,
  Math.min(100, Number(process.env.SOLARD_HELIUS_POLL_LIMIT ?? "35")),
);
const COMMITMENT = (process.env.SOLARD_HELIUS_COMMITMENT ?? "confirmed") as
  "processed" | "confirmed" | "finalized";
const RECENT_CURSOR = `${WORKER}:recent-signatures`;
const MAX_SEEN = 1500;

function heliusRpcUrl(): string {
  const explicit =
    process.env.HELIUS_RPC_URL?.trim() ||
    process.env.RPC_ENDPOINT?.trim() ||
    process.env.SOLANA_RPC_URL?.trim();
  if (explicit) return explicit;
  const key = process.env.HELIUS_API_KEY?.trim();
  if (key)
    return `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`;
  throw new Error(
    "Missing HELIUS_RPC_URL, RPC_ENDPOINT, SOLANA_RPC_URL, or HELIUS_API_KEY",
  );
}

function redactedUrl(url: string): string {
  return url.replace(/api-key=([^&]+)/i, "api-key=<redacted>");
}

function loadSeen(): Set<string> {
  const raw = getCursor(RECENT_CURSOR);
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw) as unknown;
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((v): v is string => typeof v === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}

function saveSeen(seen: Set<string>): void {
  const recent = Array.from(seen).slice(-MAX_SEEN);
  setCursor(RECENT_CURSOR, JSON.stringify(recent));
}

function trimSeen(seen: Set<string>): void {
  if (seen.size <= MAX_SEEN) return;
  const recent = Array.from(seen).slice(-MAX_SEEN);
  seen.clear();
  for (const sig of recent) seen.add(sig);
}

async function processSignature(
  connection: Connection,
  signature: string,
  solUsd: number | null,
) {
  return await workerMeasure.measure(
    {
      start: () => "helius process pump tx",
      end: (result) => result,
      catch: (error) => ({
        error: error instanceof Error ? error.message : String(error),
      }),
    },
    async () => {
      const tx = await measureRetry(
        "helius.getTransaction",
        { attempts: 3, delay: 120, backoff: 2 },
        () =>
          connection.getTransaction(signature, {
            commitment: COMMITMENT,
            maxSupportedTransactionVersion: 0,
          }),
      );
      if (!tx) return { signature, skipped: "missing-transaction" };
      const parsed = parsePumpTransaction({
        tx,
        signature,
        solUsd,
        now: Date.now(),
      });
      const applied = await applyParsedPumpTransaction({
        parsed,
        source: "helius-poll",
        confidence:
          COMMITMENT === "finalized"
            ? "finalized"
            : COMMITMENT === "confirmed"
              ? "confirmed"
              : "processed",
        solUsd,
      });
      return {
        signature: signature.slice(0, 8),
        creates: parsed.creates.length,
        trades: parsed.trades.length,
        completes: parsed.completes?.length ?? 0,
        ...applied,
      };
    },
  );
}

async function tick(connection: Connection, seen: Set<string>) {
  const solUsd = await resolveSolUsd();
  const signatures = await measureRetry(
    "helius.getSignaturesForAddress",
    { attempts: 3, delay: 200, backoff: 2 },
    () =>
      connection.getSignaturesForAddress(
        new PublicKey(PUMPFUN_PROGRAM_ID),
        {
          limit: LIMIT,
        },
        COMMITMENT,
      ),
  );
  const fresh = signatures.filter(
    (row) => !seen.has(row.signature) && !row.err,
  );
  let tokens = 0;
  let trades = 0;
  let imaged = 0;
  let completes = 0;
  let errors = 0;
  for (const row of fresh.reverse()) {
    seen.add(row.signature);
    const result = await processSignature(
      connection,
      row.signature,
      solUsd,
    ).catch((error) => {
      errors++;
      return {
        error: error instanceof Error ? error.message : String(error),
      } as Record<string, unknown>;
    });
    tokens += Number((result as any).tokens ?? 0);
    trades += Number((result as any).trades ?? 0);
    imaged += Number((result as any).imaged ?? 0);
    completes += Number((result as any).completes ?? 0);
  }
  trimSeen(seen);
  saveSeen(seen);
  return {
    polled: signatures.length,
    fresh: fresh.length,
    tokens,
    trades,
    imaged,
    completes,
    errors,
    solUsd,
    newest: signatures[0]?.signature ?? null,
    newestSlot: signatures[0]?.slot ?? null,
  };
}

async function main() {
  const url = heliusRpcUrl();
  const connection = new Connection(url, COMMITMENT);
  const seen = loadSeen();
  upsertProcessStatus({
    name: WORKER,
    kind: "stream",
    status: "starting",
    data: {
      source: "helius",
      buildId: BUILD_ID,
      mode: "http-poll",
      url: redactedUrl(url),
      pollMs: POLL_MS,
      limit: LIMIT,
      commitment: COMMITMENT,
    },
  });

  while (true) {
    await workerMeasure.measure(
      {
        start: () => "helius live poll tick",
        end: (result) => ({ result: summarizeForMeasure(result) }),
        catch: (error) => {
          upsertProcessStatus({
            name: WORKER,
            kind: "stream",
            status: "error",
            error,
            data: {
              source: "helius",
              buildId: BUILD_ID,
              mode: "http-poll",
              url: redactedUrl(url),
            },
          });
          return null;
        },
      },
      async () => {
        const result = await tick(connection, seen);
        upsertProcessStatus({
          name: WORKER,
          kind: "stream",
          status: "ok",
          data: {
            source: "helius",
            buildId: BUILD_ID,
            mode: "http-poll",
            url: redactedUrl(url),
            ...result,
          },
        });
        return result;
      },
    );
    await Bun.sleep(POLL_MS);
  }
}

process.on("SIGINT", () => {
  upsertProcessStatus({
    name: WORKER,
    kind: "stream",
    status: "stopped",
    data: { reason: "SIGINT", buildId: BUILD_ID },
  });
  process.exit(0);
});
process.on("SIGTERM", () => {
  upsertProcessStatus({
    name: WORKER,
    kind: "stream",
    status: "stopped",
    data: { reason: "SIGTERM", buildId: BUILD_ID },
  });
  process.exit(0);
});

main().catch((error) => {
  upsertProcessStatus({
    name: WORKER,
    kind: "stream",
    status: "fatal",
    error,
    data: { source: "helius", buildId: BUILD_ID },
  });
  throw error;
});
