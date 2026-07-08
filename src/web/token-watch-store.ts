import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type TokenWatchSample = {
  capturedAtMs: number;
  marketCapSol: number | null;
  source?: string | null;
};

export type TokenWatchToken = {
  mint: string;
  name?: string | null;
  symbol?: string | null;
  creator?: string | null;
  uri?: string | null;
  signature?: string | null;
  addedAtMs: number;
  updatedAtMs: number;
  samples: TokenWatchSample[];
};

export type TokenWatchGroup = {
  id: string;
  name: string;
  createdAtMs: number;
  updatedAtMs: number;
  tokens: TokenWatchToken[];
};

export type TokenWatchVault = {
  version: 1;
  groups: TokenWatchGroup[];
};

export type TokenWatchTokenSummary = TokenWatchToken & {
  lastMarketCapSol: number | null;
  sma1m: number | null;
  sma5m: number | null;
  sma15m: number | null;
  sma60m: number | null;
};

export type TokenWatchGroupSummary = Omit<TokenWatchGroup, "tokens"> & {
  tokens: TokenWatchTokenSummary[];
};

const MAX_SAMPLES_PER_TOKEN = 2_000;

function storePath(): string {
  return resolve(
    process.env.SOLWAL_WATCH_GROUPS_PATH ||
      process.env.SOWL_WATCH_GROUPS_PATH ||
      "./data/solwal-token-watch-groups.json",
  );
}

function clean(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function groupId(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") || `group-${Date.now()}`
  );
}

function readVault(): TokenWatchVault {
  const path = storePath();
  if (!existsSync(path)) return { version: 1, groups: [] };
  const parsed = JSON.parse(
    readFileSync(path, "utf8"),
  ) as Partial<TokenWatchVault>;
  return {
    version: 1,
    groups: Array.isArray(parsed.groups) ? parsed.groups : [],
  };
}

function writeVault(vault: TokenWatchVault): void {
  const path = storePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(vault, null, 2)}\n`, "utf8");
}

function sma(
  samples: TokenWatchSample[],
  periodMs: number,
  now = Date.now(),
): number | null {
  const values = samples
    .filter((sample) => sample.capturedAtMs >= now - periodMs)
    .map((sample) => sample.marketCapSol)
    .filter(
      (value): value is number =>
        typeof value === "number" && Number.isFinite(value),
    );
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

function summarizeToken(
  token: TokenWatchToken,
  now = Date.now(),
): TokenWatchTokenSummary {
  const sorted = [...(token.samples ?? [])].sort(
    (a, b) => b.capturedAtMs - a.capturedAtMs,
  );
  const last = sorted.find(
    (sample) =>
      typeof sample.marketCapSol === "number" &&
      Number.isFinite(sample.marketCapSol),
  );
  return {
    ...token,
    samples: sorted,
    lastMarketCapSol: last?.marketCapSol ?? null,
    sma1m: sma(sorted, 60_000, now),
    sma5m: sma(sorted, 5 * 60_000, now),
    sma15m: sma(sorted, 15 * 60_000, now),
    sma60m: sma(sorted, 60 * 60_000, now),
  };
}

export function listTokenWatchGroups(): TokenWatchGroupSummary[] {
  const now = Date.now();
  return readVault().groups.map((group) => ({
    ...group,
    tokens: [...group.tokens]
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
      .map((token) => summarizeToken(token, now)),
  }));
}

export function createTokenWatchGroup(
  nameInput: string,
): TokenWatchGroupSummary {
  const name = clean(nameInput);
  if (!name) throw new Error("Watch group name is required");
  const vault = readVault();
  const existing = vault.groups.find(
    (group) => group.name.toLowerCase() === name.toLowerCase(),
  );
  if (existing)
    return listTokenWatchGroups().find((group) => group.id === existing.id)!;
  const now = Date.now();
  const group: TokenWatchGroup = {
    id: groupId(name),
    name,
    createdAtMs: now,
    updatedAtMs: now,
    tokens: [],
  };
  vault.groups.push(group);
  writeVault(vault);
  return summarizeGroup(group);
}

function summarizeGroup(group: TokenWatchGroup): TokenWatchGroupSummary {
  const now = Date.now();
  return {
    ...group,
    tokens: group.tokens.map((token) => summarizeToken(token, now)),
  };
}

export function addTokenToWatchGroup(args: {
  groupId: string;
  mint: string;
  name?: string | null;
  symbol?: string | null;
  creator?: string | null;
  uri?: string | null;
  signature?: string | null;
  marketCapSol?: number | null;
  source?: string | null;
}): TokenWatchGroupSummary {
  const mint = clean(args.mint);
  if (!mint) throw new Error("Token mint is required");
  const vault = readVault();
  let group = vault.groups.find((item) => item.id === args.groupId);
  if (!group) {
    group = {
      id: args.groupId || "main",
      name: args.groupId || "main",
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      tokens: [],
    };
    vault.groups.push(group);
  }
  const now = Date.now();
  let token = group.tokens.find((item) => item.mint === mint);
  if (!token) {
    token = {
      mint,
      name: clean(args.name),
      symbol: clean(args.symbol),
      creator: clean(args.creator),
      uri: clean(args.uri),
      signature: clean(args.signature),
      addedAtMs: now,
      updatedAtMs: now,
      samples: [],
    };
    group.tokens.push(token);
  } else {
    token.name = clean(args.name) ?? token.name ?? null;
    token.symbol = clean(args.symbol) ?? token.symbol ?? null;
    token.creator = clean(args.creator) ?? token.creator ?? null;
    token.uri = clean(args.uri) ?? token.uri ?? null;
    token.signature = clean(args.signature) ?? token.signature ?? null;
    token.updatedAtMs = now;
  }
  if (
    typeof args.marketCapSol === "number" &&
    Number.isFinite(args.marketCapSol)
  ) {
    token.samples.push({
      capturedAtMs: now,
      marketCapSol: args.marketCapSol,
      source: clean(args.source) ?? "manual",
    });
    token.samples = token.samples.slice(-MAX_SAMPLES_PER_TOKEN);
  }
  group.updatedAtMs = now;
  writeVault(vault);
  return summarizeGroup(group);
}

export function removeTokenFromWatchGroup(
  groupId: string,
  mintInput: string,
): TokenWatchGroupSummary {
  const mint = clean(mintInput);
  if (!mint) throw new Error("Token mint is required");
  const vault = readVault();
  const group = vault.groups.find((item) => item.id === groupId);
  if (!group) throw new Error(`Watch group not found: ${groupId}`);
  group.tokens = group.tokens.filter((token) => token.mint !== mint);
  group.updatedAtMs = Date.now();
  writeVault(vault);
  return summarizeGroup(group);
}
