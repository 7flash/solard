export type LadderConfig = {
  lowerCap: number; upperCap: number; stepBps: number; portionBps: number;
  budgetLamports: string; sizing: "fixed" | "remaining"; bounds: "pause" | "allocate";
};
export type LadderState = {
  anchorCap: number; bin: number; initialized: boolean;
  cashLamports: string; tokenRaw: string; initialTokenRaw: string;
  initialCashLamports: string; feesLamports: string;
};
export type LadderOrder = {
  side: "buy" | "sell"; kind: "initial" | "step" | "boundary";
  cap: number; bin: number; amountRaw: string;
};
export function validateLadder(c: LadderConfig) {
  if (!Number.isFinite(c.lowerCap) || !Number.isFinite(c.upperCap) || c.lowerCap <= 0 || c.upperCap <= c.lowerCap)
    throw Error("Positive increasing market-cap bounds required");
  if (!Number.isInteger(c.stepBps) || c.stepBps < 1 || c.stepBps > 5000 ||
      !Number.isInteger(c.portionBps) || c.portionBps < 1 || c.portionBps > 10000)
    throw Error("Invalid step/portion basis points");
  if (!/^\d+$/.test(c.budgetLamports) || BigInt(c.budgetLamports) < 2n || BigInt(c.budgetLamports) > 18446744073709551615n ||
      !["fixed", "remaining"].includes(c.sizing) || !["pause", "allocate"].includes(c.bounds))
    throw Error("Budget, sizing and boundary behavior required");
  if (Math.log(c.upperCap / c.lowerCap) / Math.log(1 + c.stepBps / 10000) > 1000)
    throw Error("Grid exceeds 1000 levels");
}
export function initialLadder(c: LadderConfig, anchorCap: number): LadderState {
  validateLadder(c);
  if (!Number.isFinite(anchorCap) || anchorCap < c.lowerCap || anchorCap > c.upperCap)
    throw Error("Starting market cap must be inside the range");
  return {anchorCap, bin: 0, initialized: false, cashLamports: c.budgetLamports,
    tokenRaw: "0", initialTokenRaw: "0", initialCashLamports: (BigInt(c.budgetLamports) / 2n).toString(), feesLamports: "0"};
}
export function ladderLevel(c: LadderConfig, s: LadderState, bin: number): number {
  if (!Number.isInteger(bin) || Math.abs(bin) > 1001) throw Error("Invalid ladder bin");
  return s.anchorCap * (bin >= 0 ? (1 + c.stepBps / 10000) ** bin : (1 - c.stepBps / 10000) ** -bin);
}
export function ladderOrder(c: LadderConfig, s: LadderState, side: "buy" | "sell", cap?: number): LadderOrder | null {
  if (!s.initialized) return side === "buy" ? {side, kind:"initial", cap:s.anchorCap, bin:0,
    amountRaw:s.initialCashLamports} : null;
  const direction = side === "buy" ? -1 : 1, bin = s.bin + direction;
  let limit = ladderLevel(c, s, bin), boundary = false;
  if (c.bounds === "allocate" && ((side === "buy" && (limit < c.lowerCap || (cap != null && cap <= c.lowerCap))) ||
      (side === "sell" && (limit > c.upperCap || (cap != null && cap >= c.upperCap))))) {
    limit = side === "buy" ? c.lowerCap : c.upperCap; boundary = true;
  } else if (limit < c.lowerCap || limit > c.upperCap) return null;
  const available = BigInt(side === "buy" ? s.cashLamports : s.tokenRaw);
  const basis = c.sizing === "remaining" ? available : BigInt(side === "buy" ? s.initialCashLamports : s.initialTokenRaw);
  const portion = boundary ? available : basis * BigInt(c.portionBps) / 10000n;
  const amount = portion > available ? available : portion;
  if (amount <= 0n) return null;
  // A boundary fill must resume from the last in-range level, not invent a level outside the range.
  let nextBin = bin;
  if (boundary) { nextBin = s.bin; for (let n = 0; n < 1001; n++) {
    const next = ladderLevel(c, s, nextBin + direction);
    if (next < c.lowerCap || next > c.upperCap) break;
    nextBin += direction;
  } }
  return {side, kind:boundary?"boundary":"step", cap:limit, bin:nextBin, amountRaw:amount.toString()};
}
export function ladderEligible(c: LadderConfig, order: LadderOrder, cap: number) {
  if (!Number.isFinite(cap) || cap <= 0 || (c.bounds === "pause" && (cap < c.lowerCap || cap > c.upperCap))) return false;
  return order.side === "buy" ? cap <= order.cap : cap >= order.cap;
}
/** Pure accounting transition. Returning a new state makes durable commit/replay idempotent. */
export function settleLadder(s: LadderState, order: LadderOrder, receipt: {
  solPrincipalDeltaLamports: string | null; targetTokenDeltaRaw: string | null; networkFeeLamports: string | null;
}): LadderState {
  if (receipt.solPrincipalDeltaLamports == null || receipt.targetTokenDeltaRaw == null || receipt.networkFeeLamports == null)
    throw Error("Confirmed fill accounting incomplete; preserve original pending submission");
  const sol = BigInt(receipt.solPrincipalDeltaLamports), tokens = BigInt(receipt.targetTokenDeltaRaw), fee = BigInt(receipt.networkFeeLamports);
  if (fee < 0n || (order.side === "buy" ? sol >= 0n || tokens <= 0n || -sol > BigInt(order.amountRaw)
    : sol <= 0n || tokens !== -BigInt(order.amountRaw))) throw Error("Fill does not match managed allocation");
  const cash = BigInt(s.cashLamports) + sol, balance = BigInt(s.tokenRaw) + tokens;
  if (cash < 0n || balance < 0n) throw Error("Fill exceeds managed inventory");
  return {...s, bin:order.bin, initialized:true, cashLamports:cash.toString(), tokenRaw:balance.toString(),
    initialTokenRaw:order.kind === "initial" ? balance.toString() : s.initialTokenRaw,
    feesLamports:(BigInt(s.feesLamports) + fee).toString()};
}
