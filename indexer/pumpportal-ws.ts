import { PublicKey } from "@solana/web3.js";
import { applyIndexedEvents } from "./apply.ts";
import type { IndexerConfig } from "./config.ts";
import type {
  Counters,
  IndexedComplete,
  IndexedCreate,
  IndexedTrade,
} from "./types.ts";

type AnyRow = Record<string, any>;

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finite(value: unknown): number | null {
  const parsed = Number(value ?? Number.NaN);
  return Number.isFinite(parsed) ? parsed : null;
}

function positive(value: unknown): number | null {
  const parsed = finite(value);
  return parsed != null && parsed > 0 ? parsed : null;
}

function timestampMs(value: unknown, fallback: number): number {
  const parsed = positive(value);
  if (parsed == null) return fallback;
  return parsed < 10_000_000_000 ? parsed * 1000 : parsed;
}

function validPumpMint(value: unknown): string | null {
  const mint = text(value);
  if (!mint || mint === WSOL_MINT || mint === USDC_MINT) return null;

  // Pump.fun launch mints are vanity-generated with the `pump` suffix. This
  // rejects quote mints and PumpSwap pool events that can otherwise resemble a
  // token-creation payload on the shared PumpPortal connection.
  if (!mint.endsWith("pump")) return null;

  try {
    return new PublicKey(mint).toBase58() === mint ? mint : null;
  } catch {
    return null;
  }
}

function eventKind(row: AnyRow): "create" | "migration" | null {
  const value = String(
    row.txType ?? row.type ?? row.event ?? row.eventType ?? row.method ?? "",
  )
    .trim()
    .toLowerCase();

  if (/migrat|complete|graduate/.test(value)) return "migration";
  if (value === "create" || value === "newtoken" || value === "new_token") {
    return "create";
  }
  return null;
}

function deriveBondingCurveKey(mint: string, programId: string): string | null {
  try {
    const [address] = PublicKey.findProgramAddressSync(
      [Buffer.from("bonding-curve"), new PublicKey(mint).toBuffer()],
      new PublicKey(programId),
    );
    return address.toBase58();
  } catch {
    return null;
  }
}

function parseCreate(
  row: AnyRow,
  receivedAtMs: number,
  config: IndexerConfig,
  currentSolUsd: number | null,
): { create: IndexedCreate; initialTrade: IndexedTrade | null } | null {
  const mint = validPumpMint(row.mint ?? row.tokenAddress ?? row.address);
  if (!mint) return null;

  // A real subscribeNewToken payload contains token metadata. Requiring it
  // prevents PumpSwap/quote-account notifications from being inserted as new
  // terminal tokens (for example the USDC mint).
  const name = text(row.name);
  const symbol = text(row.symbol);
  const uri = text(row.uri ?? row.metadataUri ?? row.metadata_uri);
  if (!name || !symbol || !uri) return null;

  const pool = text(row.pool)?.toLowerCase();
  if (pool && pool !== "pump" && pool !== "pump.fun" && pool !== "pumpfun") {
    return null;
  }

  const bondingCurveKey =
    text(row.bondingCurveKey ?? row.bondingCurve ?? row.bonding_curve) ??
    deriveBondingCurveKey(mint, config.programId);
  if (!bondingCurveKey) return null;

  const createdAtMs = timestampMs(
    row.timestamp ?? row.createdAt ?? row.created_at ?? row.blockTime,
    receivedAtMs,
  );
  const signature =
    text(row.signature ?? row.txSignature ?? row.sig) ??
    `pumpportal:${mint}:${createdAtMs}`;
  const slot = Math.trunc(finite(row.slot) ?? 0);
  const owner = text(row.creator ?? row.traderPublicKey ?? row.user);

  const create: IndexedCreate = {
    kind: "create",
    mint,
    bondingCurveKey,
    creator: owner,
    name,
    symbol,
    uri,
    signature,
    slot,
    createdAtMs,
    raw: row,
  };

  const initialBuy = positive(
    row.initialBuy ?? row.initial_buy ?? row.tokenAmount ?? row.token_amount,
  );
  const solAmount = positive(
    row.solAmount ?? row.sol_amount ?? row.quoteAmount ?? row.quote_amount,
  );
  const marketCapSol = positive(
    row.marketCapSol ?? row.market_cap_sol ?? row.mcapSol ?? row.mcap_sol,
  );

  if (initialBuy == null || solAmount == null) {
    return { create, initialTrade: null };
  }

  const priceSol =
    marketCapSol != null
      ? marketCapSol / config.pumpSupplyUi
      : solAmount / initialBuy;
  if (!Number.isFinite(priceSol) || priceSol <= 0) {
    return { create, initialTrade: null };
  }

  const solUsd = currentSolUsd ?? config.solUsd;
  const initialTrade: IndexedTrade = {
    kind: "trade",
    eventKey: `pumpportal:${signature}:initial-buy:${mint}`,
    mint,
    signature,
    slot,
    owner,
    side: "buy",
    tokenDeltaUi: initialBuy,
    solDeltaUi: solAmount,
    priceSol,
    priceUsd: solUsd != null ? priceSol * solUsd : null,
    marketCapSol: marketCapSol ?? priceSol * config.pumpSupplyUi,
    marketCapUsd:
      solUsd != null
        ? (marketCapSol ?? priceSol * config.pumpSupplyUi) * solUsd
        : null,
    createdAtMs,
    raw: row,
  };

  return { create, initialTrade };
}

function parseMigration(
  row: AnyRow,
  receivedAtMs: number,
): IndexedComplete | null {
  const mint = validPumpMint(row.mint ?? row.tokenAddress ?? row.address);
  if (!mint) return null;
  return {
    kind: "complete",
    mint,
    bondingCurveKey: text(
      row.bondingCurveKey ?? row.bondingCurve ?? row.bonding_curve,
    ),
    owner: text(row.creator ?? row.traderPublicKey ?? row.user),
    signature:
      text(row.signature ?? row.txSignature ?? row.sig) ??
      `pumpportal:migration:${mint}:${receivedAtMs}`,
    slot: Math.trunc(finite(row.slot) ?? 0),
    createdAtMs: timestampMs(
      row.timestamp ?? row.createdAt ?? row.created_at ?? row.blockTime,
      receivedAtMs,
    ),
    raw: row,
  };
}

export async function runPumpPortalSession(input: {
  config: IndexerConfig;
  counters: Counters;
  signal: AbortSignal;
  onCreated: (event: IndexedCreate) => void;
  onMigrated: (mint: string) => void;
}): Promise<void> {
  const { config, counters, signal } = input;
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(config.pumpPortalUrl);
    let closed = false;

    const finish = (error?: unknown) => {
      if (closed) return;
      closed = true;
      signal.removeEventListener("abort", abort);
      try {
        socket.close();
      } catch {}
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish();
    signal.addEventListener("abort", abort, { once: true });

    socket.addEventListener("open", () => {
      counters.sessions++;
      socket.send(JSON.stringify({ method: "subscribeNewToken" }));
      socket.send(JSON.stringify({ method: "subscribeMigration" }));
    });

    let queue: Promise<void> = Promise.resolve();
    socket.addEventListener("message", (event: any) => {
      const raw = String(event.data ?? "");
      counters.messages++;
      queue = queue
        .then(async () => {
          let row: AnyRow;
          try {
            row = JSON.parse(raw);
          } catch {
            counters.errors++;
            return;
          }

          const kind = eventKind(row);
          if (!kind) return;
          const receivedAtMs = Date.now();

          if (kind === "create") {
            const parsed = parseCreate(
              row,
              receivedAtMs,
              config,
              counters.solUsd,
            );
            if (!parsed) {
              counters.skipped++;
              return;
            }

            const events = parsed.initialTrade
              ? [parsed.create, parsed.initialTrade]
              : [parsed.create];
            const result = await applyIndexedEvents(events, {
              config,
              counters,
            });
            if (result.applied > 0) input.onCreated(parsed.create);
            return;
          }

          const parsed = parseMigration(row, receivedAtMs);
          if (!parsed) {
            counters.skipped++;
            return;
          }
          const result = await applyIndexedEvents([parsed], {
            config,
            counters,
          });
          if (result.applied > 0) input.onMigrated(parsed.mint);
        })
        .catch((error) => {
          counters.errors++;
          console.error("[solard:pumpportal] message failed", error);
        });
    });

    socket.addEventListener("error", () =>
      finish(new Error("PumpPortal websocket error")),
    );
    socket.addEventListener("close", () => void queue.finally(() => finish()));
  });
}
