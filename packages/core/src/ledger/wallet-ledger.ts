import bs58 from "bs58";
import {
  PublicKey,
  SystemProgram,
  ComputeBudgetProgram,
  type Connection,
  type ParsedTransactionWithMeta,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  NATIVE_MINT,
} from "@solana/spl-token";
import {
  AMM_V4,
  CREATE_CPMM_POOL_PROGRAM,
  CLMM_PROGRAM_ID,
  LAUNCHPAD_PROGRAM,
} from "@raydium-io/raydium-sdk-v2";
import {
  PUMP_PROGRAM_ID,
  PUMP_AMM_PROGRAM_ID,
} from "../venues/pump/constants.ts";
import { DYNAMIC_BONDING_CURVE_PROGRAM_ID } from "../venues/meteora/dbc.ts";
import { CP_AMM_PROGRAM_ID } from "../venues/meteora/damm-v2.ts";
import { HELIUS_TIP_ACCOUNTS } from "../tx/helius-landing.ts";

// Verified against https://docs.jito.wtf/lowlatencytxnsend/ on 2026-10-07.
const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];
const TIP_ACCOUNTS = new Set<string>([
  ...HELIUS_TIP_ACCOUNTS,
  ...JITO_TIP_ACCOUNTS,
]);
const PROGRAM_VENUES = new Map([
  [PUMP_PROGRAM_ID.toBase58(), "pump-curve"],
  [PUMP_AMM_PROGRAM_ID.toBase58(), "pumpswap"],
  [DYNAMIC_BONDING_CURVE_PROGRAM_ID.toBase58(), "meteora-dbc"],
  [CP_AMM_PROGRAM_ID.toBase58(), "meteora-damm-v2"],
  [LAUNCHPAD_PROGRAM.toBase58(), "raydium-launchlab"],
  [AMM_V4.toBase58(), "raydium-amm"],
  [CREATE_CPMM_POOL_PROGRAM.toBase58(), "raydium-cpmm"],
  [CLMM_PROGRAM_ID.toBase58(), "raydium-clmm"],
]);
function text(value: any): string {
  return typeof value === "string"
    ? value
    : (value?.toBase58?.() ?? value?.pubkey?.toBase58?.() ?? "");
}
function exact(value: unknown): bigint | null {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? BigInt(value)
    : typeof value === "string" && /^-?\d+$/.test(value)
      ? BigInt(value)
      : null;
}
type InstructionRow = { instruction: any; parent: number; inner: boolean };
function instructionRows(
  transaction: ParsedTransactionWithMeta,
): InstructionRow[] {
  const outer = transaction.transaction.message.instructions;
  return [
    ...outer.map((instruction, parent) => ({
      instruction,
      parent,
      inner: false,
    })),
    ...(transaction.meta?.innerInstructions ?? []).flatMap((row) =>
      row.instructions.map((instruction) => ({
        instruction,
        parent: row.index,
        inner: true,
      })),
    ),
  ];
}
export type WalletLedgerTokenDelta = {
  mint: string;
  decimals: number;
  beforeRaw: bigint;
  afterRaw: bigint;
  deltaRaw: bigint;
  accounts: string[];
};
export type WalletLedgerEntry = {
  signature: string;
  slot: number;
  atMs: number | null;
  status: "confirmed" | "failed";
  classifications: string[];
  venues: string[];
  solDeltaLamports: bigint | null;
  tokenDeltas: WalletLedgerTokenDelta[];
  tradeSide: "buy" | "sell" | "mixed" | null;
  networkFeeLamports: bigint | null;
  priorityFeeLamports: bigint | null;
  tipLamports: bigint;
  /** Signed changes; fees and tips are negative, rent opening negative/closing positive. */
  components: {
    networkFee: bigint | null;
    tips: bigint;
    tokenAccountRent: bigint;
    transfers: bigint;
    wrapUnwrap: bigint;
    tradePrincipal: bigint;
    claims: bigint;
    residual: bigint | null;
  };
  /** Native SOL plus owned WSOL quantity delta; rent and fees remain separate. */
  economicSolDeltaLamports: bigint | null;
  warnings: string[];
};

/** Pure, chain-metadata accounting. Unknown program effects remain in residual. */
export function walletLedgerEntry(
  transaction: ParsedTransactionWithMeta,
  wallet: PublicKey,
  signature = transaction.transaction.signatures[0] ?? "",
): WalletLedgerEntry {
  const owner = wallet.toBase58();
  const meta = transaction.meta;
  const warnings: string[] = [];
  const keys = transaction.transaction.message.accountKeys.map(text);
  const walletIndex = keys.indexOf(owner);
  const beforeSol =
    walletIndex < 0 ? 0n : exact(meta?.preBalances[walletIndex]);
  const afterSol =
    walletIndex < 0 ? 0n : exact(meta?.postBalances[walletIndex]);
  const solDelta =
    beforeSol === null || afterSol === null ? null : afterSol - beforeSol;
  if (solDelta === null)
    warnings.push(
      "Native balance metadata is missing or exceeds exact JavaScript integer precision.",
    );
  const fee = keys[0] === owner ? exact(meta?.fee) : 0n;
  const failed = meta?.err != null;
  const rows = instructionRows(transaction);
  const top = transaction.transaction.message.instructions;
  const venues = [
    ...new Set(
      rows
        .map((row) => PROGRAM_VENUES.get(text(row.instruction.programId)))
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  const names = rows
    .filter((row) => PROGRAM_VENUES.has(text(row.instruction.programId)))
    .map((row) => String(row.instruction.parsed?.type ?? ""));
  const programStack: string[] = [];
  for (const line of meta?.logMessages ?? []) {
    const invoked = /^Program (\S+) invoke \[\d+\]/.exec(line);
    if (invoked) {
      programStack.push(invoked[1]!);
      continue;
    }
    const finished = /^Program (\S+) (?:success|failed:)/.exec(line);
    if (finished) {
      const index = programStack.lastIndexOf(finished[1]!);
      if (index >= 0) programStack.splice(index);
      continue;
    }
    const decoded = /^Program log: Instruction: (.+)/.exec(line);
    if (decoded && PROGRAM_VENUES.has(programStack.at(-1) ?? ""))
      names.push(decoded[1]!);
  }
  const trade =
    venues.length > 0 && names.some((name) => /^(buy|sell|swap)/i.test(name));
  const claim =
    venues.length > 0 &&
    names.some((name) => /claim|collect.*fee|withdraw.*fee/i.test(name));
  const launch =
    venues.length > 0 &&
    names.some((name) =>
      /^(create|initialize.*pool|initialize.*mint)/i.test(name),
    );
  const hasBuy = trade && names.some((name) => /^buy/i.test(name));
  const hasSell = trade && names.some((name) => /^sell/i.test(name));
  const tradeSide =
    hasBuy && hasSell ? "mixed" : hasBuy ? "buy" : hasSell ? "sell" : null;
  const ownership = new Map<number, string>();
  for (const balance of [
    ...(meta?.preTokenBalances ?? []),
    ...(meta?.postTokenBalances ?? []),
  ])
    if (balance.owner) ownership.set(balance.accountIndex, balance.owner);
  for (const { instruction } of rows) {
    const parsed = instruction.parsed;
    if (/^initializeAccount/.test(parsed?.type ?? "") && parsed.info?.owner) {
      const index = keys.indexOf(String(parsed.info.account));
      if (index >= 0) ownership.set(index, String(parsed.info.owner));
    }
  }
  const owned = new Set<number>();
  const balances = new Map<string, WalletLedgerTokenDelta>();
  for (const [phase, tokenRows] of [
    ["before", meta?.preTokenBalances ?? []],
    ["after", meta?.postTokenBalances ?? []],
  ] as const) {
    for (const row of tokenRows) {
      if ((row.owner ?? ownership.get(row.accountIndex)) !== owner) continue;
      owned.add(row.accountIndex);
      const amount = BigInt(row.uiTokenAmount.amount);
      const value = balances.get(row.mint) ?? {
        mint: row.mint,
        decimals: row.uiTokenAmount.decimals,
        beforeRaw: 0n,
        afterRaw: 0n,
        deltaRaw: 0n,
        accounts: [],
      };
      if (phase === "before") value.beforeRaw += amount;
      else value.afterRaw += amount;
      if (!value.accounts.includes(keys[row.accountIndex]!))
        value.accounts.push(keys[row.accountIndex]!);
      balances.set(row.mint, value);
    }
  }
  const tokenDeltas = [...balances.values()].map((value) => ({
    ...value,
    deltaRaw: value.afterRaw - value.beforeRaw,
  }));
  const wsolDelta =
    tokenDeltas.find((row) => row.mint === NATIVE_MINT.toBase58())?.deltaRaw ??
    0n;
  let tips = 0n;
  let rent = 0n;
  let transfers = 0n;
  let wraps = 0n;
  let principal = 0n;
  let claims = 0n;
  let cuLimit: bigint | null = null;
  let cuPrice: bigint | null = null;
  for (const { instruction } of rows) {
    if (
      text(instruction.programId) !==
        ComputeBudgetProgram.programId.toBase58() ||
      !instruction.data
    )
      continue;
    try {
      const data = Buffer.from(bs58.decode(instruction.data));
      if (data[0] === 2 && data.length === 5)
        cuLimit = BigInt(data.readUInt32LE(1));
      if (data[0] === 3 && data.length === 9) cuPrice = data.readBigUInt64LE(1);
    } catch {
      warnings.push("Compute budget instruction could not be decoded.");
    }
  }
  const priority =
    cuPrice === null
      ? 0n
      : cuPrice === 0n
        ? 0n
        : cuLimit === null
          ? null
          : (cuLimit * cuPrice + 999999n) / 1000000n;
  const ownedText = new Set([...owned].map((index) => keys[index]!));
  const wsolText = new Set(
    [...(meta?.preTokenBalances ?? []), ...(meta?.postTokenBalances ?? [])]
      .filter(
        (row) =>
          row.mint === NATIVE_MINT.toBase58() && owned.has(row.accountIndex),
      )
      .map((row) => keys[row.accountIndex]!),
  );
  if (!failed) {
    for (const { instruction } of rows)
      if (
        /^initializeAccount/.test(instruction.parsed?.type ?? "") &&
        instruction.parsed.info?.owner === owner
      ) {
        ownedText.add(String(instruction.parsed.info.account));
        if (instruction.parsed.info.mint === NATIVE_MINT.toBase58())
          wsolText.add(String(instruction.parsed.info.account));
      }
    for (const row of rows) {
      const instruction = row.instruction;
      const parsed = instruction.parsed;
      const info = parsed?.info ?? {};
      const program = text(instruction.programId);
      const parentProgram = text((top[row.parent] as any)?.programId);
      if (
        program === SystemProgram.programId.toBase58() &&
        parsed?.type === "transfer"
      ) {
        const amount = exact(info.lamports);
        if (amount === null) {
          warnings.push("System transfer amount is not exact.");
          continue;
        }
        const from = String(info.source);
        const to = String(info.destination);
        const direction = (to === owner ? 1n : 0n) - (from === owner ? 1n : 0n);
        if (!direction) continue;
        if (from === owner && TIP_ACCOUNTS.has(to)) {
          tips += amount;
          continue;
        }
        if (from === owner && wsolText.has(to)) {
          wraps -= amount;
          continue;
        }
        if (row.inner && PROGRAM_VENUES.has(parentProgram)) {
          if (claim && !trade && !launch) claims += direction * amount;
          else if (trade && !claim && !launch) principal += direction * amount;
          continue;
        }
        if (!row.inner && !ownedText.has(from) && !ownedText.has(to))
          transfers += direction * amount;
      }
      if (
        program === SystemProgram.programId.toBase58() &&
        /^createAccount/.test(parsed?.type ?? "") &&
        info.source === owner &&
        ownedText.has(String(info.newAccount))
      ) {
        const index = keys.indexOf(String(info.newAccount));
        const post = exact(meta?.postBalances[index]);
        const raw = meta?.postTokenBalances?.find(
          (balance) =>
            balance.accountIndex === index &&
            balance.mint === NATIVE_MINT.toBase58(),
        )?.uiTokenAmount.amount;
        if (
          exact(meta?.preBalances[index]) === 0n &&
          post !== null &&
          post > 0n
        )
          rent -= post - BigInt(raw ?? "0");
      }
      if (
        (program === TOKEN_PROGRAM_ID.toBase58() ||
          program === TOKEN_2022_PROGRAM_ID.toBase58()) &&
        parsed?.type === "closeAccount" &&
        info.destination === owner &&
        ownedText.has(String(info.account))
      ) {
        const index = keys.indexOf(String(info.account));
        const pre = exact(meta?.preBalances[index]);
        const raw = meta?.preTokenBalances?.find(
          (balance) =>
            balance.accountIndex === index &&
            balance.mint === NATIVE_MINT.toBase58(),
        )?.uiTokenAmount.amount;
        if (pre !== null && exact(meta?.postBalances[index]) === 0n) {
          rent += pre - BigInt(raw ?? "0");
          if (raw) wraps += BigInt(raw);
        }
      }
    }
  }
  const networkComponent = fee === null ? null : -fee;
  const known =
    (networkComponent ?? 0n) -
    tips +
    rent +
    transfers +
    wraps +
    principal +
    claims;
  const residual = solDelta === null || fee === null ? null : solDelta - known;
  if (residual !== 0n)
    warnings.push(
      "Native SOL change includes an unclassified residual; principal/claim attribution is incomplete.",
    );
  const classifications = failed
    ? ["failed-fee"]
    : [
        ...(trade ? ["trade"] : []),
        ...(claim ? ["claim"] : []),
        ...(launch ? ["launch"] : []),
        ...(transfers !== 0n ? ["transfer-sol"] : []),
        ...(tokenDeltas.some((row) => row.deltaRaw !== 0n) && !trade && !launch
          ? ["transfer-token"]
          : []),
      ];
  return {
    signature,
    slot: transaction.slot,
    atMs: transaction.blockTime == null ? null : transaction.blockTime * 1000,
    status: failed ? "failed" : "confirmed",
    classifications,
    venues,
    tradeSide: failed ? null : tradeSide,
    solDeltaLamports: solDelta,
    tokenDeltas,
    networkFeeLamports: fee,
    priorityFeeLamports: keys[0] === owner ? priority : 0n,
    tipLamports: tips,
    components: {
      networkFee: networkComponent,
      tips: -tips,
      tokenAccountRent: rent,
      transfers,
      wrapUnwrap: wraps,
      tradePrincipal: principal,
      claims,
      residual,
    },
    economicSolDeltaLamports: solDelta === null ? null : solDelta + wsolDelta,
    warnings,
  };
}

export type WalletLedgerOptions = {
  since?: number | string | Date;
  sinceMs?: number;
  untilMs?: number;
  maxPages?: number;
  maxTransactions?: number;
  maxAddresses?: number;
  additionalHistoricalAddresses?: readonly (PublicKey | string)[];
  commitment?: "confirmed" | "finalized";
};
export type WalletLedger = {
  wallet: string;
  entries: WalletLedgerEntry[];
  coverage: {
    status: "partial";
    scannedAddresses: string[];
    truncated: boolean;
    missingTransactions: string[];
    failedAddressScans: string[];
    historyQueryComplete: boolean;
    warnings: string[];
  };
};

/** Pass the SDK's raw-transaction-caching Connection to reuse durable transaction history. */
export async function walletLedger(
  connection: Connection,
  wallet: PublicKey,
  options: WalletLedgerOptions = {},
): Promise<WalletLedger> {
  if (options.since != null && options.sinceMs == null)
    options = {
      ...options,
      sinceMs:
        typeof options.since === "number"
          ? options.since
          : new Date(options.since).getTime(),
    };
  const commitment = options.commitment ?? "finalized";
  for (const value of [options.sinceMs, options.untilMs])
    if (value !== undefined && (!Number.isFinite(value) || value < 0))
      throw new Error("Ledger time bounds must be finite and nonnegative");
  if (
    options.sinceMs !== undefined &&
    options.untilMs !== undefined &&
    options.sinceMs > options.untilMs
  )
    throw new Error("Ledger sinceMs must not exceed untilMs");
  const maxPages = options.maxPages ?? 3;
  const maxTransactions = options.maxTransactions ?? 1000;
  const maxAddresses = options.maxAddresses ?? 256;
  for (const value of [maxPages, maxTransactions, maxAddresses])
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error("Ledger bounds must be positive integers");
  const addresses = new Set<string>([
    wallet.toBase58(),
    ...(options.additionalHistoricalAddresses ?? []).map((address) =>
      new PublicKey(address).toBase58(),
    ),
  ]);
  const warnings = [
    "Current token accounts and supplied historical addresses cannot prove coverage of every closed historical token account.",
  ];
  const failedAddressScans: string[] = [];
  const current = await Promise.allSettled(
    [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map((programId) =>
      connection.getParsedTokenAccountsByOwner(
        wallet,
        { programId },
        commitment,
      ),
    ),
  );
  for (const result of current)
    if (result.status === "fulfilled")
      for (const row of result.value.value)
        addresses.add(row.pubkey.toBase58());
    else
      warnings.push(
        "A current token-account scan failed; incoming token coverage is incomplete.",
      );
  const scanAddresses = [...addresses].slice(0, maxAddresses);
  let truncated = addresses.size > maxAddresses;
  const signatures = new Map<string, number>();
  for (const address of scanAddresses) {
    let before: string | undefined;
    try {
      for (let page = 0; page < maxPages; page++) {
        const rows = await connection.getSignaturesForAddress(
          new PublicKey(address),
          { before, limit: Math.min(1000, maxTransactions) },
          commitment,
        );
        if (!rows.length) break;
        for (const row of rows) {
          const at = row.blockTime == null ? null : row.blockTime * 1000;
          if (
            at !== null &&
            ((options.sinceMs !== undefined && at < options.sinceMs) ||
              (options.untilMs !== undefined && at > options.untilMs))
          )
            continue;
          if (
            signatures.size >= maxTransactions &&
            !signatures.has(row.signature)
          ) {
            truncated = true;
            continue;
          }
          signatures.set(row.signature, row.slot);
        }
        if (
          rows.length < Math.min(1000, maxTransactions) ||
          (options.sinceMs !== undefined &&
            rows.at(-1)?.blockTime != null &&
            rows.at(-1)!.blockTime! * 1000 < options.sinceMs)
        )
          break;
        if (page === maxPages - 1) truncated = true;
        before = rows.at(-1)!.signature;
      }
    } catch {
      failedAddressScans.push(address);
    }
  }
  const entries: WalletLedgerEntry[] = [];
  const missingTransactions: string[] = [];
  const ids = [...signatures.keys()];
  const batchSize = Math.max(
    1,
    Math.min(
      5,
      Number(
        process.env.SLRD_RPC_MAX_REQUESTS ?? process.env.SLRD_RPC_MAX_RPS ?? 5,
      ) || 5,
    ),
  );
  for (let offset = 0; offset < ids.length; offset += batchSize) {
    const batch = ids.slice(offset, offset + batchSize);
    try {
      const transactions = await connection.getParsedTransactions(batch, {
        commitment,
        maxSupportedTransactionVersion: 1,
      });
      for (let index = 0; index < batch.length; index++) {
        const transaction = transactions[index];
        if (!transaction) {
          missingTransactions.push(batch[index]!);
          continue;
        }
        try {
          const entry = walletLedgerEntry(transaction, wallet, batch[index]!);
          if (
            entry.atMs !== null &&
            ((options.sinceMs !== undefined && entry.atMs < options.sinceMs) ||
              (options.untilMs !== undefined && entry.atMs > options.untilMs))
          )
            continue;
          if (
            entry.atMs === null &&
            (options.sinceMs !== undefined || options.untilMs !== undefined)
          )
            warnings.push(
              `Transaction ${batch[index]} has no timestamp; membership of the requested time window is unknown.`,
            );
          entries.push(entry);
        } catch {
          missingTransactions.push(batch[index]!);
        }
      }
    } catch {
      missingTransactions.push(...batch);
    }
  }
  entries.sort(
    (a, b) => a.slot - b.slot || a.signature.localeCompare(b.signature),
  );
  if (truncated)
    warnings.push("Requested bounds truncated address or transaction history.");
  if (missingTransactions.length)
    warnings.push("Some discovered transactions could not be read.");
  return {
    wallet: wallet.toBase58(),
    entries,
    coverage: {
      status: "partial",
      scannedAddresses: scanAddresses,
      truncated,
      missingTransactions,
      failedAddressScans,
      historyQueryComplete:
        !truncated &&
        !missingTransactions.length &&
        !failedAddressScans.length &&
        current.every((result) => result.status === "fulfilled"),
      warnings,
    },
  };
}
