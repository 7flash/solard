import bs58 from "bs58";
import {
  ComputeBudgetProgram,
  SystemProgram,
  type Connection,
  type VersionedTransaction,
} from "@solana/web3.js";
import type { SolardBundleSender } from "../sender.ts";

const JITO_SENDER_BUILD = "2026-07-13-fresh-tip-ladder-v8";

export type JitoBundleLanding = {
  status: "landed" | "failed" | "invalid" | "expired" | "retry";
  slot: number | null;
  detail?: string;
};

export const JITO_BUNDLE_BLOCKHASH_EXPIRED =
  "JITO_BUNDLE_BLOCKHASH_EXPIRED" as const;

export class JitoBundleExpiredError extends Error {
  readonly code = JITO_BUNDLE_BLOCKHASH_EXPIRED;

  constructor(message: string) {
    super(message);
    this.name = "JitoBundleExpiredError";
  }
}

/**
 * Bun can load the same source through more than one module identity when
 * `.js` specifiers are resolved to TypeScript at runtime. Do not rely solely
 * on `instanceof` when an expiry error crosses SDK/launch module boundaries.
 */
export function isJitoBundleExpiredError(error: unknown): error is Error & {
  code?: typeof JITO_BUNDLE_BLOCKHASH_EXPIRED;
} {
  if (error instanceof JitoBundleExpiredError) return true;
  if (error == null || typeof error !== "object") return false;

  const candidate = error as {
    code?: unknown;
    name?: unknown;
    message?: unknown;
  };

  if (candidate.code === JITO_BUNDLE_BLOCKHASH_EXPIRED) return true;
  if (candidate.name === "JitoBundleExpiredError") return true;

  return (
    typeof candidate.message === "string" &&
    /(?:bundle contains an expired blockhash|expired blockhash|blockhash (?:has )?expired|exhausted its recent blockhash)/i.test(
      candidate.message,
    )
  );
}

export const JITO_BUNDLE_GENERATION_RETRY =
  "JITO_BUNDLE_GENERATION_RETRY" as const;

export class JitoBundleGenerationRetryError extends Error {
  readonly code = JITO_BUNDLE_GENERATION_RETRY;

  constructor(message: string) {
    super(message);
    this.name = "JitoBundleGenerationRetryError";
  }
}

export function isJitoBundleGenerationRetryError(
  error: unknown,
): error is Error & {
  code?: typeof JITO_BUNDLE_GENERATION_RETRY;
} {
  if (error instanceof JitoBundleGenerationRetryError) return true;
  if (error == null || typeof error !== "object") return false;

  const candidate = error as {
    code?: unknown;
    name?: unknown;
    message?: unknown;
  };

  if (candidate.code === JITO_BUNDLE_GENERATION_RETRY) return true;
  if (candidate.name === "JitoBundleGenerationRetryError") return true;

  return (
    typeof candidate.message === "string" &&
    /generation did not land within|fresh tip generation/i.test(
      candidate.message,
    )
  );
}

type InflightBundleRow = {
  bundle_id?: string;
  bundleId?: string;
  status?: string;
  landed_slot?: number | null;
  landedSlot?: number | null;
};

type InflightBundleResult = {
  value?: InflightBundleRow[] | null;
};

type BundleHistoryRow = {
  bundle_id?: string;
  bundleId?: string;
  transactions?: string[];
  slot?: number | null;
  confirmation_status?: string;
  confirmationStatus?: string;
  err?: unknown;
};

type BundleHistoryResult = {
  value?: BundleHistoryRow[] | null;
};

type StoredBundle = {
  serialized: string[];
  signatures: string[];
  byteLengths: number[];
  connection: Connection;
  submittedAt: number;
  recentBlockhash: string;
};

function transactionSignature(transaction: VersionedTransaction): string {
  const signature = transaction.signatures[0];
  if (!signature)
    throw new Error("Signed transaction is missing its payer signature");
  return bs58.encode(signature);
}

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer; got ${raw}`);
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bundleUrl(endpoint: string): string {
  const clean = endpoint.replace(/\/$/, "");
  if (/\/api\/v1\/bundles(?:\?|$)/i.test(clean)) return clean;
  if (/helius-rpc\.com/i.test(clean) || /api-key=/i.test(clean))
    return endpoint;
  return `${clean}/api/v1/bundles`;
}

function statusBaseEndpoint(endpoint: string): string {
  const clean = endpoint.replace(/\/$/, "");
  if (/helius-rpc\.com/i.test(clean) || /api-key=/i.test(clean))
    return endpoint;
  return clean
    .replace(/\/api\/v1\/bundles(?:\?.*)?$/i, "")
    .replace(/\/api\/v1\/get(?:Inflight)?BundleStatuses(?:\?.*)?$/i, "");
}

function bundleMethodUrl(endpoint: string, method: string): string {
  const base = statusBaseEndpoint(endpoint);
  if (/helius-rpc\.com/i.test(base) || /api-key=/i.test(base)) return base;
  return `${base.replace(/\/$/, "")}/api/v1/${method}`;
}

function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return left === right;
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  label: string,
): Promise<Response> {
  const timeoutMs = positiveInteger("JITO_BUNDLE_HTTP_TIMEOUT_MS", 4_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`${label} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function postJsonRpc<T>(
  url: string,
  method: string,
  params: unknown[],
): Promise<T | null> {
  const response = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method,
        params,
      }),
    },
    `Jito ${method}`,
  );

  const raw = await response.text();
  let data: { result?: T; error?: unknown } | null = null;
  try {
    data = JSON.parse(raw) as { result?: T; error?: unknown };
  } catch {
    // Preserve the raw body in the error below.
  }

  if (!response.ok || data?.error) {
    const detail = JSON.stringify(
      data?.error ?? raw.slice(0, 500) ?? response.status,
    );
    throw new Error(
      `Jito ${method} failed with HTTP ${response.status}: ${detail}`,
    );
  }

  return data?.result ?? null;
}

export async function getJitoTipAccounts(
  endpoint = process.env.JITO_BLOCK_ENGINE_URL ??
    "https://mainnet.block-engine.jito.wtf",
): Promise<string[]> {
  const result = await postJsonRpc<string[]>(
    bundleMethodUrl(endpoint, "getTipAccounts"),
    "getTipAccounts",
    [],
  );
  const accounts = (result ?? []).filter(
    (value): value is string =>
      typeof value === "string" && value.trim().length > 0,
  );
  if (accounts.length !== 8) {
    throw new Error(
      `Jito getTipAccounts returned ${accounts.length} accounts; expected 8.`,
    );
  }
  return accounts;
}

function expiredBlockhashFailure(detail: string): boolean {
  return /expired blockhash|blockhash[^\n]*expired|blockhash not found/i.test(
    detail,
  );
}

function retryableFailure(status: number, detail: string): boolean {
  if (status === 429 || status === 502 || status === 503 || status === 504)
    return true;
  return /busy|too many requests|rate.?limit|temporar|unavailable|overload|timed out|abort/i.test(
    detail,
  );
}

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after")?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0)
      return Math.max(1_000, Math.ceil(seconds * 1_000));
  }

  const configured = positiveInteger("JITO_BUNDLE_RETRY_INTERVAL_MS", 1_100);
  return Math.min(5_000, configured * Math.max(1, attempt));
}

function historyErrorDetail(error: unknown): string | null {
  if (error === null || error === undefined) return null;
  if (typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(record, "Ok")) return null;
  }
  return JSON.stringify(error);
}

function normalizedHistoryStatus(row: BundleHistoryRow): string {
  return (row.confirmation_status ?? row.confirmationStatus ?? "")
    .trim()
    .toLowerCase();
}

function statusSource(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

type StaticSolTransfer = {
  from: string;
  to: string;
  lamports: bigint;
};

function requestedComputeUnitLimit(
  transaction: VersionedTransaction,
): number | null {
  const message = transaction.message;
  for (const instruction of message.compiledInstructions) {
    const program = message.staticAccountKeys[instruction.programIdIndex];
    if (!program?.equals(ComputeBudgetProgram.programId)) continue;
    const data = Buffer.from(instruction.data);
    // ComputeBudgetInstruction::SetComputeUnitLimit
    if (data.length >= 5 && data[0] === 2) {
      return data.readUInt32LE(1);
    }
  }
  return null;
}

function staticSolTransfers(
  transaction: VersionedTransaction,
): StaticSolTransfer[] {
  const message = transaction.message;
  const transfers: StaticSolTransfer[] = [];

  for (const instruction of message.compiledInstructions) {
    const program = message.staticAccountKeys[instruction.programIdIndex];
    if (!program?.equals(SystemProgram.programId)) continue;

    const data = Buffer.from(instruction.data);
    // SystemInstruction::Transfer = 2 (u32 LE), followed by lamports u64 LE.
    if (data.length < 12 || data.readUInt32LE(0) !== 2) continue;
    const fromIndex = instruction.accountKeyIndexes[0];
    const toIndex = instruction.accountKeyIndexes[1];
    if (fromIndex == null || toIndex == null) continue;

    const from = message.staticAccountKeys[fromIndex];
    const to = message.staticAccountKeys[toIndex];
    if (!from || !to) continue;

    transfers.push({
      from: from.toBase58(),
      to: to.toBase58(),
      lamports: data.readBigUInt64LE(4),
    });
  }

  return transfers;
}

export class JitoSender implements SolardBundleSender {
  readonly id = "jito";
  private readonly storedBundles = new Map<string, StoredBundle>();
  private tipAccountsCache: {
    expiresAt: number;
    accounts: string[];
  } | null = null;

  constructor(
    private readonly endpoint = "https://mainnet.block-engine.jito.wtf",
  ) {}

  async send({
    connection,
    transaction,
  }: Parameters<SolardBundleSender["send"]>[0]): Promise<string> {
    await this.sendBundle({ connection, transactions: [transaction] });
    return transactionSignature(transaction);
  }

  private async currentTipAccounts(): Promise<string[]> {
    const now = Date.now();
    if (this.tipAccountsCache && this.tipAccountsCache.expiresAt > now) {
      return this.tipAccountsCache.accounts;
    }

    const accounts = await getJitoTipAccounts(this.endpoint);

    this.tipAccountsCache = {
      expiresAt: now + 5 * 60_000,
      accounts,
    };
    return accounts;
  }

  private async verifyAuctionAdmission(
    transactions: VersionedTransaction[],
  ): Promise<{
    tipAccount: string;
    tipLamports: bigint;
    requestedCuLimits: Array<number | null>;
  }> {
    const tipAccounts = await this.currentTipAccounts();
    const finalTransaction = transactions.at(-1);
    if (!finalTransaction) {
      throw new Error("Jito bundle has no final transaction.");
    }

    const transfer = staticSolTransfers(finalTransaction).find(
      (candidate) =>
        tipAccounts.includes(candidate.to) && candidate.lamports >= 1_000n,
    );
    if (!transfer) {
      throw new Error(
        "The final bundle transaction does not contain a static System " +
          "Program transfer of at least 1000 lamports to one of the current " +
          "Jito getTipAccounts destinations.",
      );
    }

    const requestedCuLimits = transactions.map(requestedComputeUnitLimit);
    const totalRequestedCu = requestedCuLimits.reduce(
      (sum, value) => sum + (value ?? 600_000),
      0,
    );

    console.log(
      "jito auction admission preflight:",
      JSON.stringify({
        senderBuild: JITO_SENDER_BUILD,
        tipAccount: transfer.to,
        tipLamports: transfer.lamports.toString(),
        requestedCuLimits,
        totalRequestedCu,
        tipLamportsPerRequestedCu:
          totalRequestedCu > 0
            ? Number(transfer.lamports) / totalRequestedCu
            : null,
        tipAccountSource: "getTipAccounts",
        tipAccountStatic: true,
      }),
    );

    return {
      tipAccount: transfer.to,
      tipLamports: transfer.lamports,
      requestedCuLimits,
    };
  }

  private async submitSerializedBundle(serialized: string[]): Promise<string> {
    const url = bundleUrl(this.endpoint);
    const maxAttempts = 1;
    const region = process.env.JITO_REGION?.trim();
    let lastFailure = "unknown Jito bundle failure";
    let attemptsUsed = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      attemptsUsed = attempt;
      let response: Response;
      try {
        response = await fetchWithTimeout(
          url,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(region && /helius-rpc\.com/i.test(url)
                ? { "jito-region": region }
                : {}),
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: Date.now(),
              method: "sendBundle",
              params: [serialized, { encoding: "base64" }],
            }),
          },
          "Jito sendBundle",
        );
      } catch (error) {
        lastFailure = error instanceof Error ? error.message : String(error);
        if (attempt === maxAttempts) break;
        await sleep(positiveInteger("JITO_BUNDLE_RETRY_INTERVAL_MS", 1_100));
        continue;
      }

      const raw = await response.text();
      let data: { result?: string; error?: unknown } | null = null;
      try {
        data = JSON.parse(raw) as { result?: string; error?: unknown };
      } catch {
        // Preserve raw response below.
      }

      if (response.ok && !data?.error && data?.result) return data.result;

      lastFailure = JSON.stringify(
        data?.error ?? raw.slice(0, 500) ?? response.status,
      );

      if (expiredBlockhashFailure(lastFailure)) {
        throw new JitoBundleExpiredError(
          `Jito rejected the signed bundle because its blockhash expired: ${lastFailure}`,
        );
      }

      const heliusPlanRestricted =
        /helius-rpc\.com/i.test(url) &&
        /business plans? or above|please upgrade/i.test(lastFailure);

      if (heliusPlanRestricted) {
        throw new Error(
          "Helius rejected sendBundle for this API plan. " +
            "Use a direct Jito block-engine endpoint such as " +
            "https://singapore.mainnet.block-engine.jito.wtf " +
            `instead of ${this.endpoint}. Details: ${lastFailure}`,
        );
      }

      if (
        attempt === maxAttempts ||
        !retryableFailure(response.status, lastFailure)
      ) {
        break;
      }

      await sleep(retryDelayMs(response, attempt));
    }

    throw new Error(
      `Jito bundle submission failed after ${attemptsUsed} attempt(s): ${lastFailure}`,
    );
  }

  async sendBundle({
    connection,
    transactions,
  }: Parameters<SolardBundleSender["sendBundle"]>[0]) {
    if (transactions.length === 0 || transactions.length > 5)
      throw new Error(
        `Jito bundle requires 1..5 transactions, got ${transactions.length}`,
      );

    await this.verifyAuctionAdmission(transactions);

    const serialized = transactions.map((transaction) =>
      Buffer.from(transaction.serialize()).toString("base64"),
    );
    const signatures = transactions.map(transactionSignature);
    const submissionId = await this.submitSerializedBundle(serialized);
    const now = Date.now();
    const byteLengths = serialized.map(
      (value) => Buffer.from(value, "base64").length,
    );

    this.storedBundles.set(submissionId, {
      serialized,
      signatures,
      byteLengths,
      connection,
      submittedAt: now,
      recentBlockhash: transactions[0]!.message.recentBlockhash,
    });

    console.log(
      "jito bundle accepted:",
      JSON.stringify({
        senderBuild: JITO_SENDER_BUILD,
        bundleId: submissionId,
        submissionEndpoint: statusSource(bundleUrl(this.endpoint)),
        transactions: transactions.length,
        byteLengths,
        signatures,
        explorer: `https://explorer.jito.wtf/bundle/${submissionId}`,
      }),
    );

    return { submissionId, signatures };
  }

  private async landedHistory(
    submissionId: string,
    url: string,
  ): Promise<JitoBundleLanding | null> {
    const result = await postJsonRpc<BundleHistoryResult>(
      url,
      "getBundleStatuses",
      [[submissionId]],
    );
    const row = result?.value?.[0] ?? null;
    if (!row) return null;

    const errorDetail = historyErrorDetail(row.err);
    if (errorDetail) {
      return {
        status: "failed",
        slot: row.slot ?? null,
        detail:
          `Jito bundle ${submissionId} has a landed-status error: ` +
          errorDetail,
      };
    }

    const confirmationStatus = normalizedHistoryStatus(row);
    if (
      confirmationStatus === "processed" ||
      confirmationStatus === "confirmed" ||
      confirmationStatus === "finalized" ||
      (row.slot !== null && row.slot !== undefined)
    ) {
      return {
        status: "landed",
        slot: row.slot ?? null,
        detail: confirmationStatus || "landed",
      };
    }

    return null;
  }

  private async inflightStatus(
    submissionId: string,
    url: string,
  ): Promise<{ status: string; slot: number | null }> {
    const result = await postJsonRpc<InflightBundleResult>(
      url,
      "getInflightBundleStatuses",
      [[submissionId]],
    );
    const row = result?.value?.[0] ?? null;
    return {
      status: row?.status?.trim().toLowerCase() ?? "not-found",
      slot: row?.landed_slot ?? row?.landedSlot ?? null,
    };
  }

  private async signatureLanding(
    stored: StoredBundle,
  ): Promise<JitoBundleLanding | null> {
    try {
      const statuses = (
        await stored.connection.getSignatureStatuses(stored.signatures, {
          searchTransactionHistory: true,
        })
      ).value;
      const present = statuses.filter(
        (status): status is NonNullable<typeof status> => status != null,
      );
      const failed = present.find((status) => status.err != null);

      if (failed) {
        return {
          status: "failed",
          slot: failed.slot ?? null,
          detail:
            "At least one bundle transaction has an on-chain error: " +
            JSON.stringify(failed.err),
        };
      }

      if (
        statuses.length === stored.signatures.length &&
        statuses.every((status) => status != null)
      ) {
        const slots = present
          .map((status) => status.slot)
          .filter((slot): slot is number => slot != null);
        const uniqueSlots = [...new Set(slots)];

        if (uniqueSlots.length !== 1) {
          return {
            status: "failed",
            slot: uniqueSlots.at(-1) ?? null,
            detail:
              "Bundle transaction signatures appeared in different slots: " +
              uniqueSlots.join(","),
          };
        }

        return {
          status: "landed",
          slot: uniqueSlots[0] ?? null,
          detail: "all transaction signatures found on-chain in one slot",
        };
      }

      if (present.length > 0) {
        console.warn(
          "jito bundle partial signature visibility:",
          JSON.stringify({
            senderBuild: JITO_SENDER_BUILD,
            signaturesFound: present.length,
            signaturesExpected: stored.signatures.length,
          }),
        );
      }
    } catch (error) {
      console.warn(
        "jito signature fallback unavailable:",
        JSON.stringify({
          senderBuild: JITO_SENDER_BUILD,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }

    return null;
  }

  async waitForBundle(submissionId: string): Promise<JitoBundleLanding> {
    const intervalMs = Math.max(
      500,
      positiveInteger("JITO_BUNDLE_STATUS_INTERVAL_MS", 1_250),
    );
    const generationWindowMs = positiveInteger(
      "JITO_BUNDLE_GENERATION_WINDOW_MS",
      8_000,
    );

    const stored = this.storedBundles.get(submissionId);
    if (!stored) {
      return {
        status: "invalid",
        slot: null,
        detail: `No stored signed bundle exists for ${submissionId}.`,
      };
    }

    const startedAt = Date.now();
    let poll = 0;

    console.log(
      "jito bundle tracking:",
      JSON.stringify({
        senderBuild: JITO_SENDER_BUILD,
        bundleId: submissionId,
        submissionEndpoint: statusSource(bundleUrl(this.endpoint)),
        confirmation: "on-chain-signatures-same-slot",
        generationWindowMs,
        statusIntervalMs: intervalMs,
        identicalByteResubmission: false,
        signatures: stored.signatures,
      }),
    );

    try {
      while (Date.now() - startedAt < generationWindowMs) {
        poll += 1;
        const landing = await this.signatureLanding(stored);
        if (landing) return landing;

        console.log(
          "jito bundle signature poll:",
          JSON.stringify({
            senderBuild: JITO_SENDER_BUILD,
            bundleId: submissionId,
            poll,
            elapsedMs: Date.now() - startedAt,
            signatures: stored.signatures,
            status: "not-visible-on-chain",
          }),
        );

        const remaining = generationWindowMs - (Date.now() - startedAt);
        if (remaining <= 0) break;
        await sleep(Math.min(intervalMs, remaining));
      }

      const finalLanding = await this.signatureLanding(stored);
      if (finalLanding) return finalLanding;

      let blockhashValid = true;
      try {
        const validity = await stored.connection.isBlockhashValid(
          stored.recentBlockhash,
          "processed",
        );
        blockhashValid = validity.value;
      } catch (error) {
        console.warn(
          "jito blockhash validity check unavailable:",
          JSON.stringify({
            senderBuild: JITO_SENDER_BUILD,
            bundleId: submissionId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }

      if (!blockhashValid) {
        return {
          status: "expired",
          slot: null,
          detail:
            `Jito bundle ${submissionId} did not land and its recent ` +
            `blockhash is no longer valid.`,
        };
      }

      return {
        status: "retry",
        slot: null,
        detail:
          `Jito bundle generation did not land within ` +
          `${generationWindowMs}ms. Build a fresh tip generation with a new ` +
          `blockhash and new signatures. Bundle: ${submissionId}`,
      };
    } finally {
      this.storedBundles.delete(submissionId);
    }
  }
}
