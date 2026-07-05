import type {
  ExecutionRow,
  GroupRow,
  GroupWalletRow,
  PositionRow,
  PriceSampleRow,
  TokenRow,
  WalletRow,
} from "../db/schema.js";
import type { SimulationResult, SubmittedPlan } from "../tx/types.js";

export function short(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.length <= 14 ? value : `${value.slice(0, 6)}…${value.slice(-6)}`;
}

export function tokenLog(row: TokenRow) {
  return {
    id: row.id,
    token: row.symbol ? `$${row.symbol}` : (row.name ?? short(row.mint)),
    mint: short(row.mint),
    venue: row.venueHint,
    decimals: row.decimals,
    creator: short(row.creator),
  };
}

export function walletLog(row: WalletRow) {
  return {
    id: row.id,
    wallet: `@${row.name}`,
    address: short(row.address),
    active: row.isActive === 1,
  };
}

export function groupLog(row: GroupRow) {
  return { id: row.id, group: row.name, description: row.description };
}

export function groupWalletLog(row: GroupWalletRow) {
  return {
    id: row.id,
    group: row.groupName,
    wallet: short(row.walletAddress),
    weightBps: row.weightBps,
  };
}

export function executionLog(row: ExecutionRow) {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    signature: short(row.signature),
    wallet: short(row.walletAddress),
    mint: short(row.mint),
    sender: row.sender,
    slot: row.slot,
    error: row.error,
  };
}

export function positionLog(row: PositionRow) {
  return {
    id: row.id,
    wallet: short(row.walletAddress),
    mint: short(row.mint),
    amountRaw: row.tokenAmountRaw,
  };
}

export function priceSampleLog(row: PriceSampleRow) {
  return {
    id: row.id,
    mint: short(row.mint),
    venue: row.venue,
    quote: row.quoteKind === "native-sol" ? "SOL" : short(row.quoteMint),
    price: row.priceQuotePerToken,
  };
}

export function simulationLog(result: SimulationResult) {
  return {
    success: result.success,
    cuUsed: result.cuUsed,
    error: result.error,
    trackedAccounts: result.accountChanges.length,
    tokenChanges: result.tokenChanges.length,
    lastLogs: result.success ? undefined : result.logs.slice(-4),
  };
}

export function submittedPlanLog(result: SubmittedPlan) {
  return {
    signature: short(result.signature),
    sender: result.sender,
    executionId: result.executionId,
    bytes: result.plan.serializedSize,
    actions: result.plan.draft.actions.length,
  };
}
