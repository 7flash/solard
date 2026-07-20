const SOL_MINT = "So11111111111111111111111111111111111111112";
const DEFAULT_CACHE_MS = 30_000;

type PriceCache = {
  value: number | null;
  expiresAtMs: number;
  pending?: Promise<number | null> | null;
};

const cache: PriceCache = { value: null, expiresAtMs: 0, pending: null };

function envPrice(): number | null {
  const raw =
    process.env.SOLARD_SOL_USD?.trim() ||
    process.env.SOLWAL_SOL_USD?.trim() ||
    process.env.SOL_PRICE_USD?.trim();
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function cacheMs(): number {
  const raw =
    process.env.SOLARD_SOL_USD_CACHE_MS?.trim() ||
    process.env.SOLWAL_SOL_USD_CACHE_MS?.trim();
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 1_000
    ? Math.floor(parsed)
    : DEFAULT_CACHE_MS;
}

function numberAtPath(
  payload: unknown,
  path: Array<string | number>,
): number | null {
  let current: unknown = payload;
  for (const key of path) {
    if (current == null || typeof current !== "object") return null;
    current = (current as Record<string | number, unknown>)[key];
  }
  const parsed =
    typeof current === "number"
      ? current
      : typeof current === "string"
        ? Number(current)
        : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4_000);
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function parseJupiterPrice(payload: unknown): number | null {
  return (
    numberAtPath(payload, [SOL_MINT, "usdPrice"]) ??
    numberAtPath(payload, [SOL_MINT, "price"]) ??
    numberAtPath(payload, ["data", SOL_MINT, "usdPrice"]) ??
    numberAtPath(payload, ["data", SOL_MINT, "price"]) ??
    numberAtPath(payload, ["data", "SOL", "price"]) ??
    numberAtPath(payload, ["data", "SOL", "usdPrice"])
  );
}

function parseCoinGeckoPrice(payload: unknown): number | null {
  return numberAtPath(payload, ["solana", "usd"]);
}

async function loadSolUsdPrice(): Promise<number | null> {
  const pinned = envPrice();
  if (pinned != null) return pinned;

  const jupiter = await fetchJson(
    `https://lite-api.jup.ag/price/v3?ids=${encodeURIComponent(SOL_MINT)}`,
  );
  const jupiterPrice = parseJupiterPrice(jupiter);
  if (jupiterPrice != null) return jupiterPrice;

  const coingecko = await fetchJson(
    "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
  );
  return parseCoinGeckoPrice(coingecko);
}

export async function resolveSolUsdPrice(
  options: { force?: boolean } = {},
): Promise<number | null> {
  const pinned = envPrice();
  if (pinned != null) {
    cache.value = pinned;
    cache.expiresAtMs = Date.now() + cacheMs();
    return pinned;
  }

  const now = Date.now();
  if (!options.force && cache.value != null && now < cache.expiresAtMs)
    return cache.value;
  if (!options.force && cache.pending) return cache.pending;

  cache.pending = loadSolUsdPrice()
    .then((value) => {
      if (value != null) {
        cache.value = value;
        cache.expiresAtMs = Date.now() + cacheMs();
      } else {
        cache.expiresAtMs = Date.now() + Math.min(cacheMs(), 10_000);
      }
      return value ?? cache.value;
    })
    .finally(() => {
      cache.pending = null;
    });

  return cache.pending;
}

export function convertSolMcapToUsd(
  value: number | null | undefined,
  solUsdPrice: number | null | undefined,
): number | null {
  if (value == null || solUsdPrice == null) return null;
  if (!Number.isFinite(value) || !Number.isFinite(solUsdPrice)) return null;
  if (value < 0 || solUsdPrice <= 0) return null;
  return value * solUsdPrice;
}
