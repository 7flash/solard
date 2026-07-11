export type IndexedCreate = {
  kind: "create";

  mint: string;
  bondingCurveKey?: string | null;
  creator?: string | null;

  name?: string | null;
  symbol?: string | null;
  uri?: string | null;

  signature: string;
  slot: number;
  createdAtMs: number;
  raw: unknown;
};

export type IndexedTrade = {
  kind: "trade";

  eventKey: string;
  mint: string;
  signature: string;
  slot: number;

  owner?: string | null;
  side: "buy" | "sell";

  tokenDeltaUi: number | null;
  solDeltaUi: number | null;

  priceSol: number | null;
  priceUsd: number | null;

  marketCapSol: number | null;
  marketCapUsd: number | null;

  createdAtMs: number;
  raw: unknown;
};

export type IndexedComplete = {
  kind: "complete";

  mint: string;
  bondingCurveKey?: string | null;
  owner?: string | null;

  signature: string;
  slot: number;
  createdAtMs: number;
  raw: unknown;
};

export type IndexedEvent = IndexedCreate | IndexedTrade | IndexedComplete;

export type LogJob = {
  signature: string;
  slot: number;
  logs: string[];
  receivedAtMs: number;
};

export type Counters = {
  sessions: number;
  messages: number;

  creates: number;
  trades: number;
  completes: number;

  duplicateTrades: number;

  metadataQueued: number;
  metadataHydrated: number;
  metadataFailed: number;

  skipped: number;
  errors: number;

  lastSignature: string | null;
  lastMint: string | null;
  lastMcapUsd: number | null;
  lastEventAtMs: number | null;

  solUsd: number | null;
  solUsdAtMs: number | null;
};

export type TokenMetadataPatch = {
  mint: string;

  name?: string | null;
  symbol?: string | null;
  image?: string | null;
  uri?: string | null;

  description?: string | null;
  website?: string | null;
  twitter?: string | null;
  telegram?: string | null;
};
