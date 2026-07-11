import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import {
  listTokensNeedingMayhemCheck,
  recordWorkerError,
  setTerminalTokenMayhem,
} from "../shared/db.js";
import type { IndexerConfig } from "./config.js";
import { indexerMeasure, summarizeError, summarizeValue } from "./measure.js";
import type { Counters } from "./types.js";

type MayhemQueueItem = {
  mint: string;
  bondingCurveKey: string | null;
  attempt: number;
};

type RpcAccount = {
  data?: [string, string];
  owner?: string;
} | null;

const BONDING_CURVE_DISCRIMINATOR = createHash("sha256")
  .update("account:BondingCurve")
  .digest()
  .subarray(0, 8);

/**
 * Official Pump BondingCurve layout:
 *
 *   8-byte Anchor discriminator
 *   five u64 reserve/supply fields
 *   complete: bool
 *   creator: pubkey
 *   is_mayhem_mode: bool
 *
 * Therefore is_mayhem_mode is byte 81.
 */
const MAYHEM_OFFSET = 81;
const RPC_BATCH_SIZE = 50;

const queue: MayhemQueueItem[] = [];

const queued = new Set<string>();

let running = 0;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

function deriveBondingCurveKey(mint: string, programId: string): string {
  const [address] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), new PublicKey(mint).toBuffer()],

    new PublicKey(programId),
  );

  return address.toBase58();
}

function decodeMayhem(account: RpcAccount, programId: string): boolean {
  if (!account) {
    throw new Error("Bonding curve account not found");
  }

  if (account.owner && account.owner !== programId) {
    throw new Error(`Unexpected bonding curve owner ${account.owner}`);
  }

  const encoded = account.data?.[0];

  if (!encoded) {
    throw new Error("Bonding curve account has no base64 data");
  }

  const data = Buffer.from(encoded, "base64");

  if (data.length <= MAYHEM_OFFSET) {
    throw new Error(`Bonding curve data too short: ${data.length}`);
  }

  if (!data.subarray(0, 8).equals(BONDING_CURVE_DISCRIMINATOR)) {
    throw new Error("Bonding curve discriminator mismatch");
  }

  const flag = data[MAYHEM_OFFSET];

  if (flag !== 0 && flag !== 1) {
    throw new Error(`Invalid Mayhem flag byte: ${flag}`);
  }

  return flag === 1;
}

async function fetchAccounts(
  config: IndexerConfig,
  addresses: string[],
): Promise<RpcAccount[]> {
  const controller = new AbortController();

  const timer = setTimeout(() => controller.abort(), config.mayhemTimeoutMs);

  try {
    const response = await fetch(config.rpcUrl, {
      method: "POST",

      signal: controller.signal,

      headers: {
        "content-type": "application/json",
      },

      body: JSON.stringify({
        jsonrpc: "2.0",

        id: Date.now(),

        method: "getMultipleAccounts",

        params: [
          addresses,

          {
            encoding: "base64",

            commitment: config.commitment,
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`Mayhem RPC HTTP ${response.status}`);
    }

    const payload = (await response.json()) as {
      error?: {
        message?: string;
      };

      result?: {
        value?: RpcAccount[];
      };
    };

    if (payload.error) {
      throw new Error(payload.error.message ?? "Mayhem RPC failed");
    }

    const values = payload.result?.value;

    if (!Array.isArray(values)) {
      throw new Error("Mayhem RPC returned no account values");
    }

    return values;
  } finally {
    clearTimeout(timer);
  }
}

function retry(
  config: IndexerConfig,
  counters: Counters,
  item: MayhemQueueItem,
): void {
  if (item.attempt >= 3) {
    counters.mayhemFailed++;
    return;
  }

  setTimeout(
    () => {
      enqueueMayhemCheck(config, counters, {
        ...item,
        attempt: item.attempt + 1,
      });
    },
    250 * 2 ** item.attempt,
  );
}

async function consume(
  config: IndexerConfig,
  counters: Counters,
): Promise<void> {
  running++;

  try {
    while (queue.length) {
      const batch = queue.splice(0, RPC_BATCH_SIZE);

      for (const item of batch) {
        queued.delete(item.mint);
      }

      const addresses = batch.map(
        (item) =>
          item.bondingCurveKey ??
          deriveBondingCurveKey(item.mint, config.programId),
      );

      try {
        const accounts = await indexerMeasure.measure(
          {
            start: () => `mayhem:accounts count=${batch.length}`,

            end: summarizeValue,

            catch: summarizeError,
          },

          async () => await fetchAccounts(config, addresses),
        );

        for (let index = 0; index < batch.length; index++) {
          const item = batch[index]!;

          try {
            const isMayhemMode = decodeMayhem(
              accounts[index] ?? null,
              config.programId,
            );

            setTerminalTokenMayhem({
              mint: item.mint,

              isMayhemMode,

              checkedAtMs: Date.now(),
            });

            counters.mayhemChecked++;

            if (isMayhemMode) {
              counters.mayhemDetected++;
            }
          } catch (error) {
            retry(config, counters, item);

            if (item.attempt >= 3) {
              recordWorkerError(config.name, error, {
                phase: "mayhem",

                mint: item.mint,

                bondingCurveKey: addresses[index],
              });
            }
          }
        }
      } catch (error) {
        for (const item of batch) {
          retry(config, counters, item);
        }

        recordWorkerError(config.name, error, {
          phase: "mayhem-batch",

          count: batch.length,
        });
      }
    }
  } finally {
    running--;

    if (queue.length) {
      pump(config, counters);
    }
  }
}

function pump(config: IndexerConfig, counters: Counters): void {
  if (!config.mayhemFetch) {
    return;
  }

  const concurrency = Math.max(
    1,
    Math.min(Math.trunc(config.mayhemConcurrency), 8),
  );

  while (running < concurrency && queue.length) {
    void consume(config, counters);
  }
}

function sweep(config: IndexerConfig, counters: Counters): void {
  for (const token of listTokensNeedingMayhemCheck(500)) {
    enqueueMayhemCheck(config, counters, {
      mint: token.mint,

      bondingCurveKey: token.bondingCurveKey,

      attempt: 0,
    });
  }
}

export function enqueueMayhemCheck(
  config: IndexerConfig,
  counters: Counters,
  input: MayhemQueueItem,
): void {
  if (!config.mayhemFetch || queued.has(input.mint)) {
    return;
  }

  queued.add(input.mint);

  queue.push(input);

  counters.mayhemQueued++;

  pump(config, counters);
}

export function startMayhemHydrator(
  config: IndexerConfig,
  counters: Counters,
): () => void {
  if (!config.mayhemFetch) {
    return () => {};
  }

  sweep(config, counters);

  sweepTimer = setInterval(
    () => sweep(config, counters),

    Math.max(1_000, config.mayhemSweepMs),
  );

  return () => {
    if (sweepTimer) {
      clearInterval(sweepTimer);

      sweepTimer = null;
    }
  };
}
