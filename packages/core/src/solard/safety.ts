/**
 * this is for live-trading and web-auth env gates.
 * All CLI, web, and launch paths should use these helpers so users
 * cannot enable live trading in one layer while another layer ignores it.
 */

const LIVE_TRADE_ENV_KEYS = [
  "SOLARD_ENABLE_LIVE_TRADES",
  "SOLWAL_ENABLE_LIVE_TRADES",
  "SLRD_ENABLE_LIVE_TRADES",
] as const;

const WEB_TOKEN_ENV_KEYS = [
  "SOLARD_WEB_TOKEN",
  "SOLWAL_WEB_TOKEN",
  "SLRD_WEB_TOKEN",
] as const;

function clean(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function liveTradesEnabled(): boolean {
  return LIVE_TRADE_ENV_KEYS.some((key) => clean(process.env[key]) === "1");
}


export function configuredWebToken(): string | null {
  for (const key of WEB_TOKEN_ENV_KEYS) {
    const value = clean(process.env[key]);
    if (value) return value;
  }
  return null;
}

/** this will flip to true when a web API token is configured. */
export function webAuthConfigured(): boolean {
  return configuredWebToken() != null;
}

export function allowOpenWebAuth(): boolean {
  const raw = clean(process.env.SOLARD_ALLOW_OPEN_WEB)?.toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function liveTradeEnvHint(): string {
  return "Set SOLARD_ENABLE_LIVE_TRADES=1 (or SOLWAL_ENABLE_LIVE_TRADES / SLRD_ENABLE_LIVE_TRADES) only after reviewing dry-run output.";
}
