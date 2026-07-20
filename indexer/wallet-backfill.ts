import { updateWatchedWalletCursor, type WatchedWallet } from "../shared/db.js";
import type { WalletIndexerConfig } from "./wallet-config.ts";
import type { WalletIndexerCounters } from "./wallet-types.ts";

type AnyRow = Record<string, any>;

type SignatureRow = {
  signature: string;
  slot: number;
  err?: unknown;
  blockTime?: number | null;
};

async function rpcCall<T>(
  config: WalletIndexerConfig,
  method: string,
  params: unknown[],
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.rpcTimeoutMs);
  try {
    const response = await fetch(config.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `${method}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
        method,
        params,
      }),
    });
    if (!response.ok) throw new Error(`${method} HTTP ${response.status}`);
    const payload = (await response.json()) as AnyRow;
    if (payload.error) {
      throw new Error(
        `${method}: ${payload.error.message ?? JSON.stringify(payload.error)}`,
      );
    }
    return payload.result as T;
  } finally {
    clearTimeout(timer);
  }
}

async function getSignatures(
  config: WalletIndexerConfig,
  wallet: WatchedWallet,
): Promise<SignatureRow[]> {
  const options: Record<string, unknown> = {
    limit: config.backfillLimit,
    commitment: config.commitment,
  };
  if (wallet.lastBackfillSignature) {
    options.until = wallet.lastBackfillSignature;
  }
  const rows = await rpcCall<SignatureRow[]>(
    config,
    "getSignaturesForAddress",
    [wallet.address, options],
  );
  return (Array.isArray(rows) ? rows : []).filter(
    (row) => row?.signature && !row.err,
  );
}

async function getTransaction(
  config: WalletIndexerConfig,
  signature: string,
): Promise<AnyRow | null> {
  return await rpcCall<AnyRow | null>(config, "getTransaction", [
    signature,
    {
      encoding: "jsonParsed",
      commitment: config.commitment,
      maxSupportedTransactionVersion: 0,
    },
  ]);
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  work: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let index = 0;
  const worker = async () => {
    while (index < values.length) {
      const current = index++;
      output[current] = await work(values[current]!);
    }
  };
  await Promise.all(
    Array.from(
      {
        length: Math.min(Math.max(1, concurrency), Math.max(1, values.length)),
      },
      worker,
    ),
  );
  return output;
}

export class WalletBackfill {
  private running = false;

  constructor(
    private readonly config: WalletIndexerConfig,
    private readonly counters: WalletIndexerCounters,
    private readonly onTransaction: (message: AnyRow) => Promise<void>,
  ) {}

  async runCycle(wallets: readonly WatchedWallet[]): Promise<void> {
    if (!this.config.backfillEnabled || this.running) return;
    this.running = true;
    this.counters.backfillCycles++;

    try {
      const selected = wallets
        .filter((wallet) => wallet.enabled > 0 && wallet.backfillEnabled > 0)
        .sort(
          (left, right) =>
            left.lastBackfillAtMs - right.lastBackfillAtMs ||
            left.createdAtMs - right.createdAtMs,
        )
        .slice(0, this.config.backfillWalletsPerCycle);

      for (const wallet of selected) {
        await this.backfillWallet(wallet);
      }
    } finally {
      this.running = false;
    }
  }

  private async backfillWallet(wallet: WatchedWallet): Promise<void> {
    this.counters.backfillWallets++;
    try {
      const signatures = await getSignatures(this.config, wallet);
      this.counters.backfillSignatures += signatures.length;

      const chronological = [...signatures].reverse();
      const transactions = await mapWithConcurrency(
        chronological,
        this.config.rpcConcurrency,
        async (signatureRow) => ({
          signatureRow,
          transaction: await getTransaction(
            this.config,
            signatureRow.signature,
          ),
        }),
      );

      for (const item of transactions) {
        if (!item.transaction) continue;
        this.counters.backfillTransactions++;
        await this.onTransaction({
          result: {
            signature: item.signatureRow.signature,
            slot: Number(item.transaction.slot ?? item.signatureRow.slot) || 0,
            blockTime:
              item.transaction.blockTime ?? item.signatureRow.blockTime ?? null,
            transaction: {
              transaction: item.transaction.transaction,
              meta: item.transaction.meta,
            },
            commitment: this.config.commitment,
          },
        });
      }

      const newest = signatures[0];
      updateWatchedWalletCursor(wallet.address, {
        signature: newest?.signature ?? wallet.lastBackfillSignature,
        slot: newest?.slot ?? wallet.lastSeenSlot,
        backfilledAtMs: Date.now(),
      });
    } catch (error) {
      this.counters.backfillErrors++;
      console.error(
        `[solard:wallet] backfill failed wallet=${wallet.address.slice(0, 8)}`,
        error,
      );
    }
  }
}
