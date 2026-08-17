import {
  PublicKey,
  type Connection,
  type ParsedTransactionWithMeta,
} from "@solana/web3.js";

export type RegistryWalletRef = {
  name: string;
  address: string;
};

export type RegistryTransferEvent = {
  signature: string;
  slot: number;
  blockTime: number | null;
  kind: "sol" | "token";
  sourceName: string;
  sourceAddress: string;
  destinationName: string;
  destinationAddress: string;
  amountRaw: string;
  mint?: string;
  decimals?: number;
};

export type RegistryTransferPair = {
  sourceName: string;
  sourceAddress: string;
  destinationName: string;
  destinationAddress: string;
  transactionCount: number;
  solLamports: string;
  tokenTransferCount: number;
  tokenMints: string[];
};

export type RegistryTransferFailure = {
  phase: "signatures" | "transactions";
  walletName?: string;
  walletAddress?: string;
  signatures?: string[];
  error: string;
};

export type RegistryTransferAnalysis = {
  complete: boolean;
  scannedWallets: number;
  signaturesPerWallet: number;
  uniqueSignatures: number;
  parsedTransactions: number;
  eventCount: number;
  failures: RegistryTransferFailure[];
  pairs: RegistryTransferPair[];
  events: RegistryTransferEvent[];
};

export type RegistryTransferProgress =
  | {
      phase: "signatures-request";
      completed: number;
      total: number;
      wallet: RegistryWalletRef;
      attempt: number;
      maxAttempts: number;
      uniqueSignatures: number;
    }
  | {
      phase: "signatures";
      completed: number;
      total: number;
      wallet: RegistryWalletRef;
      fetched: number;
      uniqueSignatures: number;
    }
  | {
      phase: "transactions-request";
      completed: number;
      total: number;
      batchSize: number;
      attempt: number;
      maxAttempts: number;
    }
  | {
      phase: "transactions";
      completed: number;
      total: number;
      parsedTransactions: number;
      eventCount: number;
    }
  | {
      phase: "retry";
      operation: "signatures" | "transactions";
      attempt: number;
      maxAttempts: number;
      error: string;
      wallet?: RegistryWalletRef;
    };

export type RegistryTransferAnalysisOptions = {
  /** Recent signatures fetched for each scanned wallet. Maximum 1,000. */
  signaturesPerWallet?: number;
  /** Optional subset of registry addresses whose history should be scanned. */
  scanAddresses?: string[];
  /** Parsed transactions fetched per RPC batch. */
  transactionBatchSize?: number;
  /** Pause between RPC requests to reduce 429s. */
  delayMs?: number;
  /** Fail an individual RPC attempt instead of waiting forever. */
  rpcTimeoutMs?: number;
  /** Retries after the first RPC attempt. */
  rpcRetries?: number;
  /** Optional progress callback for long-running CLI/reporting workflows. */
  onProgress?: (progress: RegistryTransferProgress) => void;
};

const pause = (ms: number) =>
  ms > 0
    ? new Promise<void>((resolve) => setTimeout(resolve, ms))
    : Promise.resolve();

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function withTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function accountKeyString(value: unknown): string | null {
  if (value instanceof PublicKey) return value.toBase58();
  if (value && typeof value === "object" && "pubkey" in value) {
    const key = (value as { pubkey?: unknown }).pubkey;
    if (key instanceof PublicKey) return key.toBase58();
    if (typeof key === "string") return key;
    if (key && typeof key === "object" && "toBase58" in key) {
      const fn = (key as { toBase58?: unknown }).toBase58;
      if (typeof fn === "function") return String(fn.call(key));
    }
  }
  if (typeof value === "string") return value;
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function rawString(value: unknown): string | null {
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0)
    return Math.trunc(value).toString();
  if (typeof value === "bigint" && value >= 0n) return value.toString();
  return null;
}

function parsedInstructions(tx: ParsedTransactionWithMeta): unknown[] {
  const top = tx.transaction.message.instructions as unknown[];
  const inner =
    tx.meta?.innerInstructions?.flatMap(
      (row) => row.instructions as unknown[],
    ) ?? [];
  return [...top, ...inner];
}

function tokenOwners(
  tx: ParsedTransactionWithMeta,
): Map<string, { owner: string; mint: string; decimals: number }> {
  const keys = tx.transaction.message.accountKeys.map((item) =>
    accountKeyString(item),
  );
  const result = new Map<
    string,
    { owner: string; mint: string; decimals: number }
  >();
  const balances = [
    ...(tx.meta?.preTokenBalances ?? []),
    ...(tx.meta?.postTokenBalances ?? []),
  ];
  for (const balance of balances) {
    const address = keys[balance.accountIndex] ?? null;
    if (!address || !balance.owner) continue;
    result.set(address, {
      owner: balance.owner,
      mint: balance.mint,
      decimals: balance.uiTokenAmount.decimals,
    });
  }
  return result;
}

function extractEvents(
  tx: ParsedTransactionWithMeta,
  signature: string,
  registry: Map<string, RegistryWalletRef>,
): RegistryTransferEvent[] {
  if (tx.meta?.err) return [];
  const events: RegistryTransferEvent[] = [];
  const owners = tokenOwners(tx);

  for (const instruction of parsedInstructions(tx)) {
    const row = asRecord(instruction);
    if (!row || !("parsed" in row)) continue;
    const parsed = asRecord(row.parsed);
    if (!parsed) continue;
    const type = typeof parsed.type === "string" ? parsed.type : "";
    const info = asRecord(parsed.info);
    if (!info) continue;
    const program = typeof row.program === "string" ? row.program : "";

    if (
      program === "system" &&
      (type === "transfer" || type === "transferWithSeed")
    ) {
      const source = typeof info.source === "string" ? info.source : null;
      const destination =
        typeof info.destination === "string" ? info.destination : null;
      const amount = rawString(info.lamports);
      if (!source || !destination || !amount || source === destination)
        continue;
      const sourceWallet = registry.get(source);
      const destinationWallet = registry.get(destination);
      if (!sourceWallet || !destinationWallet) continue;
      events.push({
        signature,
        slot: tx.slot,
        blockTime: tx.blockTime ?? null,
        kind: "sol",
        sourceName: sourceWallet.name,
        sourceAddress: source,
        destinationName: destinationWallet.name,
        destinationAddress: destination,
        amountRaw: amount,
      });
      continue;
    }

    if (
      (program === "spl-token" || program === "spl-token-2022") &&
      (type === "transfer" || type === "transferChecked")
    ) {
      const sourceAccount =
        typeof info.source === "string" ? info.source : null;
      const destinationAccount =
        typeof info.destination === "string" ? info.destination : null;
      if (!sourceAccount || !destinationAccount) continue;
      const sourceToken = owners.get(sourceAccount);
      const destinationToken = owners.get(destinationAccount);
      if (!sourceToken || !destinationToken) continue;
      const sourceWallet = registry.get(sourceToken.owner);
      const destinationWallet = registry.get(destinationToken.owner);
      if (
        !sourceWallet ||
        !destinationWallet ||
        sourceToken.owner === destinationToken.owner
      )
        continue;
      const tokenAmount = asRecord(info.tokenAmount);
      const amount = rawString(info.amount) ?? rawString(tokenAmount?.amount);
      if (!amount) continue;
      events.push({
        signature,
        slot: tx.slot,
        blockTime: tx.blockTime ?? null,
        kind: "token",
        sourceName: sourceWallet.name,
        sourceAddress: sourceToken.owner,
        destinationName: destinationWallet.name,
        destinationAddress: destinationToken.owner,
        amountRaw: amount,
        mint: sourceToken.mint,
        decimals:
          typeof tokenAmount?.decimals === "number"
            ? tokenAmount.decimals
            : sourceToken.decimals,
      });
    }
  }
  return events;
}

function summarize(events: RegistryTransferEvent[]): RegistryTransferPair[] {
  const rows = new Map<
    string,
    {
      sourceName: string;
      sourceAddress: string;
      destinationName: string;
      destinationAddress: string;
      signatures: Set<string>;
      solLamports: bigint;
      tokenTransferCount: number;
      tokenMints: Set<string>;
    }
  >();
  for (const event of events) {
    const key = `${event.sourceAddress}>${event.destinationAddress}`;
    let row = rows.get(key);
    if (!row) {
      row = {
        sourceName: event.sourceName,
        sourceAddress: event.sourceAddress,
        destinationName: event.destinationName,
        destinationAddress: event.destinationAddress,
        signatures: new Set<string>(),
        solLamports: 0n,
        tokenTransferCount: 0,
        tokenMints: new Set<string>(),
      };
      rows.set(key, row);
    }
    row.signatures.add(event.signature);
    if (event.kind === "sol") row.solLamports += BigInt(event.amountRaw);
    else {
      row.tokenTransferCount++;
      if (event.mint) row.tokenMints.add(event.mint);
    }
  }
  return [...rows.values()]
    .map((row) => ({
      sourceName: row.sourceName,
      sourceAddress: row.sourceAddress,
      destinationName: row.destinationName,
      destinationAddress: row.destinationAddress,
      transactionCount: row.signatures.size,
      solLamports: row.solLamports.toString(),
      tokenTransferCount: row.tokenTransferCount,
      tokenMints: [...row.tokenMints].sort(),
    }))
    .sort((a, b) => {
      if (a.transactionCount !== b.transactionCount)
        return b.transactionCount - a.transactionCount;
      const aSol = BigInt(a.solLamports);
      const bSol = BigInt(b.solLamports);
      if (aSol !== bSol) return aSol > bSol ? -1 : 1;
      return `${a.sourceName}>${a.destinationName}`.localeCompare(
        `${b.sourceName}>${b.destinationName}`,
      );
    });
}

export async function analyzeRegistryTransfers(
  connection: Connection,
  wallets: RegistryWalletRef[],
  options: RegistryTransferAnalysisOptions = {},
): Promise<RegistryTransferAnalysis> {
  const signaturesPerWallet = Math.max(
    1,
    Math.min(1_000, options.signaturesPerWallet ?? 50),
  );
  const batchSize = Math.max(
    1,
    Math.min(100, options.transactionBatchSize ?? 25),
  );
  const delayMs = Math.max(0, options.delayMs ?? 100);
  const rpcTimeoutMs = Math.max(1_000, options.rpcTimeoutMs ?? 15_000);
  const rpcRetries = Math.max(0, Math.min(10, options.rpcRetries ?? 2));
  const maxAttempts = rpcRetries + 1;
  const registry = new Map(
    wallets.map((wallet) => [wallet.address, wallet] as const),
  );
  const scan = options.scanAddresses?.length
    ? wallets.filter((wallet) =>
        options.scanAddresses!.includes(wallet.address),
      )
    : wallets;
  const failures: RegistryTransferFailure[] = [];

  const signatures = new Map<string, number>();
  for (let index = 0; index < scan.length; index++) {
    const wallet = scan[index]!;
    let rows: Awaited<
      ReturnType<Connection["getSignaturesForAddress"]>
    > | null = null;
    let finalError = "";

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      options.onProgress?.({
        phase: "signatures-request",
        completed: index,
        total: scan.length,
        wallet,
        attempt,
        maxAttempts,
        uniqueSignatures: signatures.size,
      });
      try {
        rows = await withTimeout(
          () =>
            connection.getSignaturesForAddress(
              new PublicKey(wallet.address),
              { limit: signaturesPerWallet },
              "confirmed",
            ),
          rpcTimeoutMs,
          `getSignaturesForAddress @${wallet.name}`,
        );
        break;
      } catch (error) {
        finalError = messageOf(error);
        if (attempt < maxAttempts) {
          options.onProgress?.({
            phase: "retry",
            operation: "signatures",
            attempt,
            maxAttempts,
            error: finalError,
            wallet,
          });
          await pause(Math.max(delayMs, 500) * attempt);
        }
      }
    }

    if (!rows) {
      failures.push({
        phase: "signatures",
        walletName: wallet.name,
        walletAddress: wallet.address,
        error: finalError || "signature history request failed",
      });
      options.onProgress?.({
        phase: "signatures",
        completed: index + 1,
        total: scan.length,
        wallet,
        fetched: 0,
        uniqueSignatures: signatures.size,
      });
      continue;
    }

    for (const row of rows) signatures.set(row.signature, row.slot);
    options.onProgress?.({
      phase: "signatures",
      completed: index + 1,
      total: scan.length,
      wallet,
      fetched: rows.length,
      uniqueSignatures: signatures.size,
    });
    await pause(delayMs);
  }

  const unique = [...signatures.keys()];
  const events: RegistryTransferEvent[] = [];
  let parsedTransactions = 0;
  for (let offset = 0; offset < unique.length; offset += batchSize) {
    const batch = unique.slice(offset, offset + batchSize);
    let transactions: Awaited<
      ReturnType<Connection["getParsedTransactions"]>
    > | null = null;
    let finalError = "";

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      options.onProgress?.({
        phase: "transactions-request",
        completed: offset,
        total: unique.length,
        batchSize: batch.length,
        attempt,
        maxAttempts,
      });
      try {
        transactions = await withTimeout(
          () =>
            connection.getParsedTransactions(batch, {
              commitment: "confirmed",
              maxSupportedTransactionVersion: 0,
            }),
          rpcTimeoutMs,
          `getParsedTransactions ${offset + 1}-${offset + batch.length}`,
        );
        break;
      } catch (error) {
        finalError = messageOf(error);
        if (attempt < maxAttempts) {
          options.onProgress?.({
            phase: "retry",
            operation: "transactions",
            attempt,
            maxAttempts,
            error: finalError,
          });
          await pause(Math.max(delayMs, 500) * attempt);
        }
      }
    }

    if (!transactions) {
      failures.push({
        phase: "transactions",
        signatures: batch,
        error: finalError || "parsed transaction request failed",
      });
      continue;
    }

    for (let index = 0; index < transactions.length; index++) {
      const tx = transactions[index];
      if (!tx) continue;
      parsedTransactions++;
      events.push(...extractEvents(tx, batch[index]!, registry));
    }
    options.onProgress?.({
      phase: "transactions",
      completed: Math.min(offset + batch.length, unique.length),
      total: unique.length,
      parsedTransactions,
      eventCount: events.length,
    });
    await pause(delayMs);
  }

  const deduped = new Map<string, RegistryTransferEvent>();
  for (const event of events) {
    const key = [
      event.signature,
      event.kind,
      event.sourceAddress,
      event.destinationAddress,
      event.mint ?? "SOL",
      event.amountRaw,
    ].join(":");
    if (!deduped.has(key)) deduped.set(key, event);
  }
  const finalEvents = [...deduped.values()].sort((a, b) => {
    if (a.slot !== b.slot) return b.slot - a.slot;
    return a.signature.localeCompare(b.signature);
  });

  return {
    complete: failures.length === 0,
    scannedWallets: scan.length,
    signaturesPerWallet,
    uniqueSignatures: unique.length,
    parsedTransactions,
    eventCount: finalEvents.length,
    failures,
    pairs: summarize(finalEvents),
    events: finalEvents,
  };
}
