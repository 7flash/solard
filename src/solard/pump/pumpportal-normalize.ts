import type { TerminalToken, TerminalTrade } from "../db/terminal-store.js";
import {
  DEFAULT_PUMP_SUPPLY_UI,
  LAMPORTS_PER_SOL,
  validPublicKey,
} from "./parse-terminal-tx.js";

export type RawPumpPortalEvent = Record<string, unknown>;

function clean(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function bool(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.toLowerCase();
    if (["1", "true", "yes"].includes(v)) return true;
    if (["0", "false", "no"].includes(v)) return false;
  }
  return null;
}

export function ipfsGateway(value: string | null | undefined): string | null {
  const text = clean(value);
  if (!text) return null;
  if (text.startsWith("ipfs://"))
    return `https://ipfs.io/ipfs/${text.slice("ipfs://".length)}`;
  return text;
}

function nested(raw: RawPumpPortalEvent, key: string): Record<string, unknown> {
  const value = raw[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function isPumpPortalCreate(raw: RawPumpPortalEvent): boolean {
  const txType = clean(raw.txType) ?? clean(raw.type) ?? clean(raw.eventType);
  return (
    txType === "create" ||
    !!clean(raw.uri) ||
    !!clean(raw.name) ||
    !!clean(raw.symbol)
  );
}

export function pumpPortalMint(raw: RawPumpPortalEvent): string | null {
  const mint = clean(raw.mint) ?? clean(raw.tokenMint) ?? clean(raw.ca);
  return mint && validPublicKey(mint) ? mint : null;
}

export function pumpPortalSignature(raw: RawPumpPortalEvent): string | null {
  return (
    clean(raw.signature) ??
    clean(raw.txSignature) ??
    clean(raw.transactionSignature) ??
    clean(raw.sig)
  );
}

function readMarketCapSol(raw: RawPumpPortalEvent): number | null {
  const snapshot = nested(raw, "bondingCurveSnapshot");
  const mcap =
    num(raw.marketCapSol) ??
    num(raw.market_cap_sol) ??
    num(raw.mcapSol) ??
    num(raw.usd_market_cap_sol) ??
    num(raw.marketCap) ??
    num(snapshot.marketCapSol);
  if (mcap != null && mcap > 0) return mcap;

  const marketCapUsd =
    num(raw.marketCapUsd) ??
    num(raw.market_cap_usd) ??
    num(raw.usdMarketCap) ??
    num(raw.market_cap_usd_current);
  const solUsd = num(raw.solUsd) ?? num(raw.solPriceUsd);
  if (marketCapUsd != null && solUsd != null && solUsd > 0)
    return marketCapUsd / solUsd;
  return null;
}

function readPriceSol(
  raw: RawPumpPortalEvent,
  marketCapSol: number | null,
): number | null {
  const snapshot = nested(raw, "bondingCurveSnapshot");
  const direct =
    num(raw.priceSolPerToken) ??
    num(raw.priceSol) ??
    num(raw.priceNative) ??
    num(snapshot.priceSolPerToken);
  if (direct != null && direct > 0) return direct;
  if (marketCapSol != null && marketCapSol > 0)
    return marketCapSol / DEFAULT_PUMP_SUPPLY_UI;

  const tokenAmount =
    num(raw.tokenAmount) ?? num(raw.tokens) ?? num(raw.tokenDeltaUi);
  const solAmount =
    num(raw.solAmount) ?? num(raw.solDeltaUi) ?? num(raw.sol_amount);
  if (
    tokenAmount != null &&
    tokenAmount > 0 &&
    solAmount != null &&
    solAmount > 0
  ) {
    return solAmount / tokenAmount;
  }
  return null;
}

function social(raw: RawPumpPortalEvent, key: string): string | null {
  const meta = nested(raw, "metadata");
  return clean(raw[key]) ?? clean(meta[key]);
}

function image(raw: RawPumpPortalEvent): string | null {
  const meta = nested(raw, "metadata");
  return (
    ipfsGateway(clean(raw.image)) ??
    ipfsGateway(clean(raw.imageUrl)) ??
    ipfsGateway(clean(raw.image_uri)) ??
    ipfsGateway(clean(meta.image)) ??
    ipfsGateway(clean(meta.imageUrl))
  );
}

export function pumpPortalTokenPatch(args: {
  raw: RawPumpPortalEvent;
  source: string;
  solUsd: number | null;
  now?: number;
}): (Partial<TerminalToken> & { mint: string }) | null {
  const raw = args.raw;
  const mint = pumpPortalMint(raw);
  if (!mint) return null;
  const now = args.now ?? Date.now();
  const marketCapSol = readMarketCapSol(raw);
  const priceSol = readPriceSol(raw, marketCapSol);
  const priceUsd =
    priceSol != null && args.solUsd != null ? priceSol * args.solUsd : null;
  const marketCapUsd =
    num(raw.marketCapUsd) ??
    num(raw.market_cap_usd) ??
    num(raw.usdMarketCap) ??
    (marketCapSol != null && args.solUsd != null
      ? marketCapSol * args.solUsd
      : null) ??
    (priceUsd != null ? priceUsd * DEFAULT_PUMP_SUPPLY_UI : null);

  return {
    mint,
    symbol: clean(raw.symbol) ?? clean(raw.ticker) ?? "",
    name: clean(raw.name) ?? clean(raw.tokenName) ?? "",
    image: image(raw),
    uri: clean(raw.uri) ?? clean(raw.metadataUri),
    description: social(raw, "description"),
    website: social(raw, "website"),
    twitter: social(raw, "twitter"),
    telegram: social(raw, "telegram"),
    creator:
      clean(raw.traderPublicKey) ?? clean(raw.creator) ?? clean(raw.user),
    bondingCurveKey:
      clean(raw.bondingCurveKey) ??
      clean(raw.bondingCurve) ??
      clean(raw.bonding_curve),
    source: args.source,
    phase: bool(raw.complete) === true ? "migrated" : "pump",
    supplyUi:
      num(raw.supplyUi) ?? num(raw.totalSupply) ?? DEFAULT_PUMP_SUPPLY_UI,
    priceSol,
    priceUsd,
    marketCapSol,
    marketCapUsd,
    initialMarketCapUsd: marketCapUsd,
    signature: pumpPortalSignature(raw),
    lastSlot: num(raw.slot) ?? 0,
    createdAtMs: now,
    updatedAtMs: now,
  };
}

export function pumpPortalTradePatch(args: {
  raw: RawPumpPortalEvent;
  source: string;
  solUsd: number | null;
  now?: number;
}):
  | (Partial<TerminalTrade> & { id: string; mint: string; signature: string })
  | null {
  const raw = args.raw;
  const mint = pumpPortalMint(raw);
  const signature = pumpPortalSignature(raw);
  if (!mint || !signature) return null;
  const now = args.now ?? Date.now();
  const tokenAmount = Math.abs(
    num(raw.tokenAmount) ??
      num(raw.tokens) ??
      num(raw.tokenDeltaUi) ??
      num(raw.tokenAmountUi) ??
      0,
  );
  const solAmount = Math.abs(
    num(raw.solAmount) ??
      num(raw.solDeltaUi) ??
      num(raw.sol_amount) ??
      num(raw.solAmountUi) ??
      0,
  );
  const priceSol = readPriceSol(raw, readMarketCapSol(raw));
  const priceUsd =
    priceSol != null && args.solUsd != null ? priceSol * args.solUsd : null;
  const marketCapSol =
    readMarketCapSol(raw) ??
    (priceSol != null ? priceSol * DEFAULT_PUMP_SUPPLY_UI : null);
  const marketCapUsd =
    num(raw.marketCapUsd) ??
    num(raw.market_cap_usd) ??
    (marketCapSol != null && args.solUsd != null
      ? marketCapSol * args.solUsd
      : null) ??
    (priceUsd != null ? priceUsd * DEFAULT_PUMP_SUPPLY_UI : null);
  const txType = clean(raw.txType) ?? clean(raw.type) ?? "unknown";
  const side = txType === "buy" || txType === "sell" ? txType : "unknown";

  return {
    id: `${signature}:${mint}:${clean(raw.traderPublicKey) ?? clean(raw.user) ?? "pumpportal"}`,
    mint,
    signature,
    slot: num(raw.slot) ?? 0,
    owner: clean(raw.traderPublicKey) ?? clean(raw.user),
    side,
    tokenDeltaUi: tokenAmount,
    solDeltaUi: solAmount > 10_000 ? solAmount / LAMPORTS_PER_SOL : solAmount,
    priceSol,
    priceUsd,
    marketCapUsd,
    confidence: "processed",
    source: args.source,
    rawJson: JSON.stringify(raw),
    createdAtMs: now,
    updatedAtMs: now,
  };
}
