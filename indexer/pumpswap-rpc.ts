import { encodeBase58 } from "./pumpswap-base58.js";
import type { PumpSwapConfig } from "./pumpswap-config.js";

type AnyRow = Record<string, any>;

export type AddressTransactionPage = {
  data: AnyRow[];
  paginationToken: string | null;
};

export type MultipleAccountValue = {
  data?: [string, string] | string;
  owner?: string;
  executable?: boolean;
  lamports?: number;
} | null;

export type MultipleAccountsResult = {
  context?: { slot?: number };
  value?: MultipleAccountValue[];
};

export async function rpcCall<T>(
  config: PumpSwapConfig,
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

    if (!response.ok) {
      throw new Error(`${method} HTTP ${response.status}`);
    }

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

export async function getTransactionsForAddress(
  config: PumpSwapConfig,
  address: string,
  input: {
    afterSlot: number;
    limit: number;
    paginationToken?: string | null;
  },
): Promise<AddressTransactionPage> {
  const options: Record<string, unknown> = {
    transactionDetails: "full",
    encoding: "jsonParsed",
    maxSupportedTransactionVersion: 0,
    commitment: config.commitment,
    sortOrder: "asc",
    limit: Math.max(1, Math.min(1_000, Math.trunc(input.limit))),
    filters: {
      status: "succeeded",
      ...(input.afterSlot > 0 ? { slot: { gt: input.afterSlot } } : {}),
    },
  };

  if (input.paginationToken) {
    options.paginationToken = input.paginationToken;
  }

  const result = await rpcCall<AnyRow>(config, "getTransactionsForAddress", [
    address,
    options,
  ]);

  return {
    data: Array.isArray(result?.data) ? result.data : [],
    paginationToken:
      typeof result?.paginationToken === "string"
        ? result.paginationToken
        : null,
  };
}

export async function getTokenAccountAmounts(
  config: PumpSwapConfig,
  addresses: string[],
): Promise<{ slot: number; amounts: Array<bigint | null> }> {
  if (addresses.length === 0) return { slot: 0, amounts: [] };
  if (addresses.length > 100) {
    throw new Error(
      `getMultipleAccounts supports at most 100 addresses, got ${addresses.length}`,
    );
  }

  // SPL token account amount is the u64 at byte offset 64. dataSlice keeps
  // Helius response traffic tiny: 8 bytes per account instead of the full
  // 165-byte token account.
  const result = await rpcCall<MultipleAccountsResult>(
    config,
    "getMultipleAccounts",
    [
      addresses,
      {
        encoding: "base64",
        commitment: config.commitment,
        dataSlice: { offset: 64, length: 8 },
      },
    ],
  );

  const values = Array.isArray(result?.value) ? result.value : [];

  return {
    slot: Number(result?.context?.slot ?? 0) || 0,
    amounts: addresses.map((_address, index) => {
      const encoded = values[index]?.data;
      const base64 = Array.isArray(encoded) ? encoded[0] : encoded;
      if (typeof base64 !== "string") return null;

      const bytes = Buffer.from(base64, "base64");
      if (bytes.length < 8) return null;
      return bytes.readBigUInt64LE(0);
    }),
  };
}

type PoolValidation = {
  canonical: boolean;
  baseMint: string | null;
  quoteMint: string | null;
};

export class CanonicalPoolValidator {
  private readonly cache = new Map<string, PoolValidation>();

  constructor(private readonly config: PumpSwapConfig) {}

  async validate(
    pool: string,
    baseMint: string,
    quoteMint: string,
  ): Promise<boolean> {
    const cached = this.cache.get(pool);

    if (cached) {
      return (
        cached.canonical &&
        cached.baseMint === baseMint &&
        cached.quoteMint === quoteMint
      );
    }

    const result = await rpcCall<AnyRow>(this.config, "getAccountInfo", [
      pool,
      { encoding: "base64", commitment: this.config.commitment },
    ]).catch(() => null);

    const value = result?.value;

    if (!value || value.owner !== this.config.programId) {
      this.cache.set(pool, {
        canonical: false,
        baseMint: null,
        quoteMint: null,
      });
      return false;
    }

    const encoded = Array.isArray(value.data) ? value.data[0] : null;
    if (typeof encoded !== "string") return false;

    const bytes = Uint8Array.from(Buffer.from(encoded, "base64"));

    /**
     * Anchor discriminator: 0..7
     * pool_bump u8:       8
     * index u16 LE:       9..10
     * creator:            11..42
     * base_mint:          43..74
     * quote_mint:         75..106
     */
    if (bytes.length < 107) return false;

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const index = view.getUint16(9, true);
    const decodedBase = encodeBase58(bytes.subarray(43, 75));
    const decodedQuote = encodeBase58(bytes.subarray(75, 107));

    const validation: PoolValidation = {
      canonical: index === 0,
      baseMint: decodedBase,
      quoteMint: decodedQuote,
    };

    this.cache.set(pool, validation);

    return (
      validation.canonical &&
      decodedBase === baseMint &&
      decodedQuote === quoteMint
    );
  }
}

export class SolUsdOracle {
  private value: number | null;
  private updatedAtMs = 0;

  constructor(private readonly config: PumpSwapConfig) {
    this.value = config.solUsd;
  }

  async get(): Promise<number | null> {
    if (
      this.value != null &&
      Date.now() - this.updatedAtMs < this.config.solUsdRefreshMs
    ) {
      return this.value;
    }

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.min(3_000, this.config.rpcTimeoutMs),
    );

    try {
      const mint = "So11111111111111111111111111111111111111112";
      const response = await fetch(
        `https://lite-api.jup.ag/price/v3?ids=${mint}`,
        {
          signal: controller.signal,
          headers: { accept: "application/json" },
        },
      );

      if (!response.ok) return this.value;

      const data = (await response.json()) as AnyRow;
      const next = Number(data?.[mint]?.usdPrice ?? data?.[mint]?.price);

      if (Number.isFinite(next) && next > 0) {
        this.value = next;
        this.updatedAtMs = Date.now();
      }

      return this.value;
    } catch {
      return this.value;
    } finally {
      clearTimeout(timer);
    }
  }
}
