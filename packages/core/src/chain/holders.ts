import { PublicKey, type Commitment, type Connection } from "@solana/web3.js";

import { readMint } from "./state.ts";
import type { TokenRow } from "../db/schema.ts";

export type TokenHolder = {
  owner: string;
  amountRaw: bigint;
  amountUi: string;
  shareBps: number;
  tokenAccounts: string[];
};

export type ExcludedTokenHolder = TokenHolder & {
  reason: string;
};

export type TokenHolderSnapshot = {
  version: 1;
  mint: string;
  tokenProgram: string;
  decimals: number;
  supplyRaw: bigint;
  slot: number;
  observedAtMs: number;
  tokenAccounts: number;
  holderCount: number;
  eligibleHolderCount: number;
  totalHeldRaw: bigint;
  eligibleTotalRaw: bigint;
  excludedTotalRaw: bigint;
  holders: TokenHolder[];
  excluded: ExcludedTokenHolder[];
};

export type TokenHolderSnapshotOptions = {
  commitment?: Extract<Commitment, "confirmed" | "finalized">;
  /** Explicit owners to exclude from the reward denominator. */
  excludeOwners?: Iterable<string | PublicKey>;
  /** Pump/PumpSwap token metadata lets Solard exclude curve/pool inventory. */
  token?: Pick<TokenRow, "bondingCurve" | "pool" | "sharingConfig"> | null;
  /** Exclude balances below this raw token amount. Defaults to 1 raw unit. */
  minimumRaw?: bigint;
};

function rawUi(raw: bigint, decimals: number): string {
  if (decimals <= 0) return raw.toString();
  const unit = 10n ** BigInt(decimals);
  const whole = raw / unit;
  const fraction = (raw % unit)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""}`;
}

function u64le(data: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let index = 7; index >= 0; index -= 1) {
    value = (value << 8n) | BigInt(data[offset + index] ?? 0);
  }
  return value;
}

function publicKey(value: string | PublicKey): string {
  return value instanceof PublicKey
    ? value.toBase58()
    : new PublicKey(value).toBase58();
}

/**
 * Read a complete holder snapshot directly from token-program accounts.
 *
 * The mint itself identifies exactly one token program, so this is one
 * getProgramAccounts snapshot rather than a stitched Token + Token-2022 view.
 * Token-2022 extensions append data after the canonical 165-byte account base;
 * mint/owner/amount remain at offsets 0/32/64.
 */
export async function snapshotTokenHolders(
  connection: Connection,
  mintInput: string | PublicKey,
  options: TokenHolderSnapshotOptions = {},
): Promise<TokenHolderSnapshot> {
  const mint =
    mintInput instanceof PublicKey ? mintInput : new PublicKey(mintInput);
  const mintInfo = await readMint(connection, mint);
  const commitment = options.commitment ?? "confirmed";
  const minimumRaw = options.minimumRaw ?? 1n;
  if (minimumRaw < 0n) throw new Error("minimumRaw cannot be negative");

  const excludedReasons = new Map<string, string>();
  const addExcluded = (
    value: string | PublicKey | null | undefined,
    reason: string,
  ) => {
    if (!value) return;
    excludedReasons.set(publicKey(value), reason);
  };
  for (const owner of options.excludeOwners ?? [])
    addExcluded(owner, "explicit");
  addExcluded(options.token?.bondingCurve, "bonding-curve");
  addExcluded(options.token?.pool, "pool");
  addExcluded(options.token?.sharingConfig, "sharing-config");

  const response = (await connection.getProgramAccounts(mintInfo.tokenProgram, {
    commitment,
    filters: [{ memcmp: { offset: 0, bytes: mint.toBase58() } }],
    withContext: true,
  } as any)) as unknown as {
    context: { slot: number };
    value: Array<{
      pubkey: PublicKey;
      account: { data: Uint8Array };
    }>;
  };

  const byOwner = new Map<
    string,
    { amountRaw: bigint; tokenAccounts: string[] }
  >();
  let tokenAccounts = 0;
  let totalHeldRaw = 0n;

  for (const row of response.value ?? []) {
    const data = row.account.data;
    if (!(data instanceof Uint8Array) || data.length < 72) continue;
    const accountMint = new PublicKey(data.subarray(0, 32));
    if (!accountMint.equals(mint)) continue;
    const owner = new PublicKey(data.subarray(32, 64)).toBase58();
    const amountRaw = u64le(data, 64);
    tokenAccounts += 1;
    totalHeldRaw += amountRaw;
    if (amountRaw < minimumRaw) continue;
    const current = byOwner.get(owner) ?? { amountRaw: 0n, tokenAccounts: [] };
    current.amountRaw += amountRaw;
    current.tokenAccounts.push(row.pubkey.toBase58());
    byOwner.set(owner, current);
  }

  let eligibleTotalRaw = 0n;
  let excludedTotalRaw = 0n;
  for (const [owner, row] of byOwner) {
    if (excludedReasons.has(owner)) excludedTotalRaw += row.amountRaw;
    else eligibleTotalRaw += row.amountRaw;
  }

  const holder = (
    owner: string,
    amountRaw: bigint,
    tokenAccounts: string[],
  ): TokenHolder => ({
    owner,
    amountRaw,
    amountUi: rawUi(amountRaw, mintInfo.decimals),
    shareBps:
      eligibleTotalRaw > 0n
        ? Number((amountRaw * 100_000_000n) / eligibleTotalRaw) / 10_000
        : 0,
    tokenAccounts: [...tokenAccounts].sort(),
  });

  const holders: TokenHolder[] = [];
  const excluded: ExcludedTokenHolder[] = [];
  for (const [owner, row] of byOwner) {
    const item = holder(owner, row.amountRaw, row.tokenAccounts);
    const reason = excludedReasons.get(owner);
    if (reason) excluded.push({ ...item, reason });
    else holders.push(item);
  }
  holders.sort((a, b) =>
    a.amountRaw === b.amountRaw
      ? a.owner.localeCompare(b.owner)
      : a.amountRaw > b.amountRaw
        ? -1
        : 1,
  );
  excluded.sort((a, b) =>
    a.amountRaw === b.amountRaw
      ? a.owner.localeCompare(b.owner)
      : a.amountRaw > b.amountRaw
        ? -1
        : 1,
  );

  return {
    version: 1,
    mint: mint.toBase58(),
    tokenProgram: mintInfo.tokenProgram.toBase58(),
    decimals: mintInfo.decimals,
    supplyRaw: mintInfo.supply,
    slot: Number(response.context?.slot ?? 0),
    observedAtMs: Date.now(),
    tokenAccounts,
    holderCount: byOwner.size,
    eligibleHolderCount: holders.length,
    totalHeldRaw,
    eligibleTotalRaw,
    excludedTotalRaw,
    holders,
    excluded,
  };
}
