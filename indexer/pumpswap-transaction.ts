import { createHash } from "node:crypto";
import { decodeBase58 } from "./pumpswap-base58.ts";
import type { PumpSwapCandidate } from "./pumpswap-types.ts";

type AnyRow = Record<string, any>;

function discriminator(name: string): string {
  return createHash("sha256")
    .update(`global:${name}`)
    .digest()
    .subarray(0, 8)
    .toString("hex");
}

const INSTRUCTIONS = new Map<string, PumpSwapCandidate["instruction"]>([
  [discriminator("buy"), "buy"],
  [discriminator("buy_exact_quote_in"), "buy_exact_quote_in"],
  [discriminator("sell"), "sell"],
]);

function keyString(value: any): string {
  if (typeof value === "string") {
    return value;
  }

  return String(value?.pubkey ?? value?.address ?? "");
}

function fullAccountKeys(transaction: AnyRow, meta: AnyRow): string[] {
  const message =
    transaction?.message ?? transaction?.transaction?.message ?? {};

  const staticKeys = (
    message.accountKeys ??
    message.staticAccountKeys ??
    []
  ).map(keyString);

  const loaded = meta?.loadedAddresses ?? {};

  return [
    ...staticKeys,
    ...(loaded.writable ?? []).map(keyString),
    ...(loaded.readonly ?? []).map(keyString),
  ];
}

function instructionProgramId(instruction: AnyRow, keys: string[]): string {
  if (instruction.programId) {
    return keyString(instruction.programId);
  }

  const index = Number(instruction.programIdIndex);

  return Number.isInteger(index) ? (keys[index] ?? "") : "";
}

function instructionAccounts(instruction: AnyRow, keys: string[]): string[] {
  return (instruction.accounts ?? []).map((account: any) => {
    if (typeof account === "number") {
      return keys[account] ?? "";
    }

    return keyString(account);
  });
}

function allInstructions(transaction: AnyRow, meta: AnyRow): AnyRow[] {
  const message =
    transaction?.message ?? transaction?.transaction?.message ?? {};

  const top = message.instructions ?? message.compiledInstructions ?? [];

  const inner = (meta?.innerInstructions ?? []).flatMap(
    (group: AnyRow) => group.instructions ?? [],
  );

  return [...top, ...inner];
}

function rawInstructionData(instruction: AnyRow): Uint8Array {
  const data = instruction.data;

  if (typeof data === "string") {
    return decodeBase58(data);
  }

  if (Array.isArray(data) && typeof data[0] === "string") {
    return data[1] === "base64"
      ? Uint8Array.from(Buffer.from(data[0], "base64"))
      : decodeBase58(data[0]);
  }

  return new Uint8Array();
}

function tokenBalanceUi(item: AnyRow): number {
  const ui = item?.uiTokenAmount ?? {};

  const direct = Number(ui.uiAmountString ?? ui.uiAmount);

  if (Number.isFinite(direct)) {
    return direct;
  }

  const raw = Number(ui.amount);

  const decimals = Number(ui.decimals ?? 0);

  return Number.isFinite(raw) ? raw / 10 ** decimals : 0;
}

function tokenBalancesByIndex(
  items: AnyRow[] | undefined,
): Map<number, number> {
  const output = new Map<number, number>();

  for (const item of items ?? []) {
    const index = Number(item.accountIndex);

    if (Number.isInteger(index)) {
      output.set(index, tokenBalanceUi(item));
    }
  }

  return output;
}

function accountTokenDelta(
  key: string,
  keys: string[],
  pre: Map<number, number>,
  post: Map<number, number>,
): number | null {
  const index = keys.indexOf(key);

  if (index < 0) {
    return null;
  }

  const before = pre.get(index);

  const after = post.get(index);

  if (before == null && after == null) {
    return null;
  }

  return (after ?? 0) - (before ?? 0);
}

function confidence(value: unknown): PumpSwapCandidate["confidence"] {
  return value === "confirmed" || value === "finalized" ? value : "processed";
}

export function normalizeTransactionNotification(message: AnyRow): {
  signature: string;
  slot: number;
  tradedAtMs: number;
  transaction: AnyRow;
  meta: AnyRow;
  confidence: PumpSwapCandidate["confidence"];
} | null {
  const result = message?.params?.result ?? message?.result ?? message;

  const wrapper = result?.transaction ?? result;

  const transaction =
    wrapper?.transaction ??
    result?.transaction?.transaction ??
    result?.transaction ??
    result;

  const meta = wrapper?.meta ?? result?.transaction?.meta ?? result?.meta;

  const signature = String(
    result?.signature ??
      wrapper?.signature ??
      transaction?.signatures?.[0] ??
      transaction?.transaction?.signatures?.[0] ??
      "",
  );

  if (!signature || !transaction || !meta || meta.err) {
    return null;
  }

  const blockTime = Number(
    result?.blockTime ?? wrapper?.blockTime ?? transaction?.blockTime,
  );

  return {
    signature,

    slot: Number(result?.slot ?? result?.context?.slot ?? 0) || 0,

    tradedAtMs:
      Number.isFinite(blockTime) && blockTime > 0
        ? blockTime * 1_000
        : Date.now(),

    transaction,
    meta,

    confidence: confidence(result?.commitment),
  };
}

export function extractPumpSwapCandidates(
  notification: ReturnType<typeof normalizeTransactionNotification>,
  programId: string,
): PumpSwapCandidate[] {
  if (!notification) {
    return [];
  }

  const { signature, slot, tradedAtMs, transaction, meta } = notification;

  const keys = fullAccountKeys(transaction, meta);

  const pre = tokenBalancesByIndex(meta.preTokenBalances);

  const post = tokenBalancesByIndex(meta.postTokenBalances);

  const groups = new Map<
    string,
    {
      pool: string;
      owner: string | null;
      baseMint: string;
      quoteMint: string;
      poolBase: string;
      poolQuote: string;
      instruction: PumpSwapCandidate["instruction"];
    }
  >();

  for (const instruction of allInstructions(transaction, meta)) {
    if (instructionProgramId(instruction, keys) !== programId) {
      continue;
    }

    const bytes = rawInstructionData(instruction);

    if (bytes.length < 8) {
      continue;
    }

    const name = INSTRUCTIONS.get(
      Buffer.from(bytes.subarray(0, 8)).toString("hex"),
    );

    if (!name) {
      continue;
    }

    const accounts = instructionAccounts(instruction, keys);

    if (accounts.length < 9) {
      continue;
    }

    const group = {
      pool: accounts[0],

      owner: accounts[1] || null,

      baseMint: accounts[3],

      quoteMint: accounts[4],

      poolBase: accounts[7],

      poolQuote: accounts[8],

      instruction: name,
    };

    const key = [group.pool, group.baseMint, group.quoteMint].join(":");

    if (!groups.has(key)) {
      groups.set(key, group);
    }
  }

  const output: PumpSwapCandidate[] = [];

  for (const group of groups.values()) {
    const baseDelta = accountTokenDelta(group.poolBase, keys, pre, post);

    const quoteDelta = accountTokenDelta(group.poolQuote, keys, pre, post);

    if (
      baseDelta == null ||
      quoteDelta == null ||
      baseDelta === 0 ||
      quoteDelta === 0 ||
      Math.sign(baseDelta) === Math.sign(quoteDelta)
    ) {
      continue;
    }

    const side =
      baseDelta < 0 && quoteDelta > 0
        ? "buy"
        : baseDelta > 0 && quoteDelta < 0
          ? "sell"
          : null;

    if (!side) {
      continue;
    }

    output.push({
      signature,
      slot,
      tradedAtMs,

      pool: group.pool,

      owner: group.owner,

      baseMint: group.baseMint,

      quoteMint: group.quoteMint,

      poolBaseTokenAccount: group.poolBase,

      poolQuoteTokenAccount: group.poolQuote,

      side,

      baseAmountUi: Math.abs(baseDelta),

      quoteAmountUi: Math.abs(quoteDelta),

      instruction: group.instruction,

      confidence: notification.confidence,
    });
  }

  return output;
}
