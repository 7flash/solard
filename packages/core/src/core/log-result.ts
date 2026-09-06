import type {
  ExecutionRow,
  GroupRow,
  GroupWalletRow,
  PositionRow,
  PriceSampleRow,
  TokenRow,
  WalletRow,
} from "../db/schema.ts";
import type { SimulationResult, SubmittedPlan } from "../tx/types.ts";
import type {
  JupiterSwapExecuteResult,
  JupiterSwapQuote,
} from "../chain/jupiter-swap-types.ts";

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
export function jupiterQuoteLog(result: JupiterSwapQuote) {
  return {
    inputMint: short(result.inputMint),
    outputMint: short(result.outputMint),
    amountRaw: result.amountRaw.toString(),
    outAmountRaw: result.outAmountRaw.toString(),
    router: result.router,
    feeBps: result.feeBps,
    feeMint: short(result.feeMint),
  };
}

export function jupiterExecuteLog(result: JupiterSwapExecuteResult) {
  return {
    status: result.status,
    code: result.code,
    signature: short(result.signature),
    inputAmount: result.inputAmountResult ?? result.totalInputAmount ?? null,
    outputAmount: result.outputAmountResult ?? result.totalOutputAmount ?? null,
    error: result.error ?? null,
  };
}

export function tradeAssetLog(result: {
  kind: "sol" | "token";
  symbol: string | null;
  decimals: number;
  tokenProgram: string | null;
}) {
  return {
    kind: result.kind,
    symbol: result.symbol,
    decimals: result.decimals,
    tokenProgram: short(result.tokenProgram),
  };
}

export function tradeRouteResolutionLog(result: {
  route: "native" | "jupiter";
  asset: { kind: "sol" | "token" };
  token: { venueHint: string | null } | null;
}) {
  return {
    route: result.route,
    assetKind: result.asset.kind,
    registered: result.token !== null,
    venue: result.token?.venueHint ?? null,
  };
}
