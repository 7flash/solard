import {
  getCopyTradeIntent,
  getCopyTradeProfile,
  listCopyTradeIntents,
  listCopyTradeProfiles,
  listProcessStatus,
  listWatchedWallets,
  updateCopyTradeIntent,
  upsertCopyTradeProfile,
  type CopyTradeIntent,
  type CopyTradeProfile,
} from "../../../shared/db.js";
import { assertWebAuth } from "../../../src/web/http.js";

type IntentStatus = CopyTradeIntent["status"];

type ProfileSummary = CopyTradeProfile & {
  intentCount: number;
  paperCount: number;
  sentCount: number;
  skippedCount: number;
  failedCount: number;
  queuedCount: number;
  lastIntentAtMs: number | null;
};

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const INTENT_STATUSES = new Set<IntentStatus>([
  "queued",
  "paper",
  "sending",
  "sent",
  "skipped",
  "failed",
]);

function response(value: unknown, status = 200): Response {
  return Response.json(
    status >= 400 ? { ok: false, error: value } : { ok: true, value },
    {
      status,
      headers: { "cache-control": "no-store" },
    },
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorStatus(error: unknown, fallback = 400): number {
  return typeof (error as { status?: unknown })?.status === "number"
    ? (error as { status: number }).status
    : fallback;
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function integer(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function finite(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function optionalNonNegative(value: unknown, label: string): number | null {
  const parsed = finite(value);
  if (parsed == null) return null;
  if (parsed < 0) throw new Error(`${label} cannot be negative.`);
  return parsed;
}

function bool(value: unknown, fallback: boolean): boolean {
  if (value == null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value > 0;
  return ["1", "true", "yes", "on", "enabled"].includes(
    String(value).trim().toLowerCase(),
  );
}

function cleanLeader(value: unknown): string {
  const address = text(value);
  if (!BASE58_ADDRESS.test(address)) {
    throw new Error("Select a valid tracked leader wallet.");
  }
  return address;
}

function cleanFollower(value: unknown): string {
  const follower = text(value);
  if (!follower)
    throw new Error("Select or enter a follower wallet reference.");
  if (follower.length > 240)
    throw new Error("Follower wallet reference is too long.");
  return follower;
}

function cleanStringArray(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\n,\s]+/g)
      : [];
  return [...new Set(raw.map((item) => text(item)).filter(Boolean))].slice(
    0,
    2_000,
  );
}

function liveSettings(): {
  allowLive: boolean;
  gatewayConfigured: boolean;
  liveReady: boolean;
} {
  const allowLive = bool(process.env.SOLARD_COPY_ALLOW_LIVE, false);
  const gatewayConfigured = Boolean(text(process.env.SOLARD_COPY_EXECUTOR_URL));
  return {
    allowLive,
    gatewayConfigured,
    liveReady: allowLive && gatewayConfigured,
  };
}

async function requestBody(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const parsed = await request.json();
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  }
  const form = await request.formData();
  return Object.fromEntries(form.entries());
}

function statusValue(value: string | null): IntentStatus | null {
  return value && INTENT_STATUSES.has(value as IntentStatus)
    ? (value as IntentStatus)
    : null;
}

function summarizeProfiles(
  profiles: readonly CopyTradeProfile[],
  intents: readonly CopyTradeIntent[],
): ProfileSummary[] {
  const byProfile = new Map<string, CopyTradeIntent[]>();
  for (const intent of intents) {
    const rows = byProfile.get(intent.profileKey) ?? [];
    rows.push(intent);
    byProfile.set(intent.profileKey, rows);
  }

  return profiles.map((profile) => {
    const rows = byProfile.get(profile.profileKey) ?? [];
    return {
      ...profile,
      intentCount: rows.length,
      paperCount: rows.filter((row) => row.status === "paper").length,
      sentCount: rows.filter((row) => row.status === "sent").length,
      skippedCount: rows.filter((row) => row.status === "skipped").length,
      failedCount: rows.filter((row) => row.status === "failed").length,
      queuedCount: rows.filter(
        (row) => row.status === "queued" || row.status === "sending",
      ).length,
      lastIntentAtMs: rows.length
        ? Math.max(...rows.map((row) => row.createdAtMs))
        : null,
    };
  });
}

function profileInput(
  body: Record<string, unknown>,
  existing: CopyTradeProfile | null,
): Parameters<typeof upsertCopyTradeProfile>[0] {
  const leaderWallet = cleanLeader(body.leaderWallet ?? existing?.leaderWallet);
  const followerRef = cleanFollower(body.followerRef ?? existing?.followerRef);
  const mode = body.mode === "live" ? "live" : "paper";
  const global = liveSettings();
  if (mode === "live" && !global.liveReady) {
    throw new Error(
      "Live copy trading is unavailable until SOLARD_COPY_ALLOW_LIVE=1 and SOLARD_COPY_EXECUTOR_URL are configured.",
    );
  }

  const buySizing =
    body.buySizing === "leader-ratio" ? "leader-ratio" : "fixed";
  const minMarketCapUsd = finite(body.minMarketCapUsd);
  const maxMarketCapUsd = finite(body.maxMarketCapUsd);
  if (
    minMarketCapUsd != null &&
    maxMarketCapUsd != null &&
    minMarketCapUsd > maxMarketCapUsd
  ) {
    throw new Error("Minimum market cap cannot exceed maximum market cap.");
  }

  const maxPriceAgeMs = optionalNonNegative(
    body.maxPriceAgeMs,
    "Maximum price age",
  );
  const minTokenAgeMs = optionalNonNegative(
    body.minTokenAgeMs,
    "Minimum token age",
  );
  const maxTokenAgeMs = optionalNonNegative(
    body.maxTokenAgeMs,
    "Maximum token age",
  );
  if (
    minTokenAgeMs != null &&
    maxTokenAgeMs != null &&
    minTokenAgeMs > maxTokenAgeMs
  ) {
    throw new Error("Minimum token age cannot exceed maximum token age.");
  }

  const minLeaderQuoteAmountUi = optionalNonNegative(
    body.minLeaderQuoteAmountUi,
    "Minimum leader trade amount",
  );
  const maxLeaderQuoteAmountUi = optionalNonNegative(
    body.maxLeaderQuoteAmountUi,
    "Maximum leader trade amount",
  );
  if (
    minLeaderQuoteAmountUi != null &&
    maxLeaderQuoteAmountUi != null &&
    minLeaderQuoteAmountUi > maxLeaderQuoteAmountUi
  ) {
    throw new Error(
      "Minimum leader trade amount cannot exceed maximum leader trade amount.",
    );
  }

  const allowedMints = cleanStringArray(body.allowedMints);
  const blockedMints = cleanStringArray(body.blockedMints);
  const allowedQuotes = cleanStringArray(body.allowedQuoteMints);
  const allowedPhases = cleanStringArray(body.allowedPhases).map((value) =>
    value.toLowerCase(),
  );
  const allowedVenues = cleanStringArray(body.allowedVenues).map((value) =>
    value.toLowerCase(),
  );
  const allowedParsers = cleanStringArray(body.allowedParsers).map((value) =>
    value.toLowerCase(),
  );
  const invalidPhase = allowedPhases.find(
    (value) => !["pump", "migrated", "unknown"].includes(value),
  );
  if (invalidPhase)
    throw new Error(`Unsupported token phase: ${invalidPhase}.`);

  const overlap = allowedMints.find((mint) => blockedMints.includes(mint));
  if (overlap) {
    throw new Error(`Mint ${overlap} cannot be both allowed and blocked.`);
  }

  const trackedLeader = listWatchedWallets({ limit: 50_000 }).find(
    (wallet) => wallet.address === leaderWallet,
  );
  if (!trackedLeader) {
    throw new Error(
      "Leader wallet is not in tracked wallets. Add it on the Tracked Wallets page first.",
    );
  }

  return {
    ...existing,
    profileKey: text(body.profileKey) || existing?.profileKey,
    leaderWallet,
    followerRef,
    label: text(body.label) || null,
    enabled: bool(body.enabled, existing ? Number(existing.enabled) > 0 : true)
      ? 1
      : 0,
    mode,
    copyBuys: bool(
      body.copyBuys,
      existing ? Number(existing.copyBuys) > 0 : true,
    )
      ? 1
      : 0,
    copySells: bool(
      body.copySells,
      existing ? Number(existing.copySells) > 0 : true,
    )
      ? 1
      : 0,
    buySizing,
    fixedBuyAmountUi: Math.max(
      0.000001,
      finite(body.fixedBuyAmountUi) ?? existing?.fixedBuyAmountUi ?? 0.05,
    ),
    leaderScaleBps: Math.max(
      1,
      Math.min(
        100_000,
        integer(body.leaderScaleBps, existing?.leaderScaleBps ?? 10_000),
      ),
    ),
    maxBuyAmountUi: Math.max(
      0.000001,
      finite(body.maxBuyAmountUi) ?? existing?.maxBuyAmountUi ?? 1,
    ),
    sellBalanceBps: Math.max(
      1,
      Math.min(
        10_000,
        integer(body.sellBalanceBps, existing?.sellBalanceBps ?? 10_000),
      ),
    ),
    slippageBps: Math.max(
      1,
      Math.min(10_000, integer(body.slippageBps, existing?.slippageBps ?? 500)),
    ),
    maxEventAgeMs: Math.max(
      1_000,
      integer(body.maxEventAgeMs, existing?.maxEventAgeMs ?? 30_000),
    ),
    requirePriceData: bool(
      body.requirePriceData,
      existing ? Number(existing.requirePriceData) > 0 : true,
    )
      ? 1
      : 0,
    allowMayhem: bool(
      body.allowMayhem,
      existing ? Number(existing.allowMayhem) > 0 : false,
    )
      ? 1
      : 0,
    minMarketCapUsd,
    maxMarketCapUsd,
    maxPriceAgeMs,
    minTokenAgeMs,
    maxTokenAgeMs,
    minHolders: optionalNonNegative(body.minHolders, "Minimum holders"),
    minTrades1m: optionalNonNegative(body.minTrades1m, "Minimum trades 1m"),
    minTrades5m: optionalNonNegative(body.minTrades5m, "Minimum trades 5m"),
    minTrades15m: optionalNonNegative(body.minTrades15m, "Minimum trades 15m"),
    minVolumeSol1m: optionalNonNegative(
      body.minVolumeSol1m,
      "Minimum volume 1m",
    ),
    minVolumeSol5m: optionalNonNegative(
      body.minVolumeSol5m,
      "Minimum volume 5m",
    ),
    minVolumeSol15m: optionalNonNegative(
      body.minVolumeSol15m,
      "Minimum volume 15m",
    ),
    minLeaderQuoteAmountUi,
    maxLeaderQuoteAmountUi,
    allowedMintsJson: JSON.stringify(allowedMints),
    blockedMintsJson: JSON.stringify(blockedMints),
    allowedQuoteMintsJson: JSON.stringify(allowedQuotes),
    allowedPhasesJson: JSON.stringify(allowedPhases),
    allowedVenuesJson: JSON.stringify(allowedVenues),
    allowedParsersJson: JSON.stringify(allowedParsers),
    updatedAtMs: Date.now(),
  };
}

export async function GET(request: Request): Promise<Response> {
  try {
    assertWebAuth(request);
    const url = new URL(request.url);
    const profileKey = text(url.searchParams.get("profileKey")) || null;
    const leaderWallet = text(url.searchParams.get("leaderWallet")) || null;
    const status = statusValue(url.searchParams.get("status"));
    const sinceMs = Math.max(0, integer(url.searchParams.get("sinceMs"), 0));
    const limit = Math.max(
      1,
      Math.min(integer(url.searchParams.get("limit"), 250), 2_000),
    );

    const profiles = listCopyTradeProfiles({
      leaderWallet,
      limit: 50_000,
    });
    const recentForStats = listCopyTradeIntents({ limit: 20_000 });
    const intents = listCopyTradeIntents({
      profileKey,
      leaderWallet,
      status,
      sinceMs,
      limit,
    });
    const processes = listProcessStatus(200);
    const worker =
      processes.find((row) =>
        /copy/i.test(`${row.name ?? ""} ${row.kind ?? ""}`),
      ) ?? null;
    const walletWorker =
      processes.find((row) =>
        /wallet/i.test(`${row.name ?? ""} ${row.kind ?? ""}`),
      ) ?? null;
    const trackedWallets = listWatchedWallets({ limit: 50_000 });
    const global = liveSettings();

    return response({
      profiles: summarizeProfiles(profiles, recentForStats),
      intents,
      trackedWallets,
      worker,
      walletWorker,
      global,
      stats: {
        profiles: profiles.length,
        enabledProfiles: profiles.filter((row) => Number(row.enabled) > 0)
          .length,
        paperProfiles: profiles.filter((row) => row.mode === "paper").length,
        liveProfiles: profiles.filter((row) => row.mode === "live").length,
        displayedIntents: intents.length,
        sentIntents: intents.filter((row) => row.status === "sent").length,
        failedIntents: intents.filter((row) => row.status === "failed").length,
        paperIntents: intents.filter((row) => row.status === "paper").length,
      },
      generatedAtMs: Date.now(),
    });
  } catch (error) {
    return response(errorMessage(error), errorStatus(error));
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertWebAuth(request);
    const body = await requestBody(request);
    const profileKey = text(body.profileKey);
    const existing = profileKey ? getCopyTradeProfile(profileKey) : null;
    const profile = upsertCopyTradeProfile(profileInput(body, existing));
    return response(profile, existing ? 200 : 201);
  } catch (error) {
    return response(errorMessage(error), errorStatus(error));
  }
}

export async function PATCH(request: Request): Promise<Response> {
  try {
    assertWebAuth(request);
    const body = await requestBody(request);
    const action = text(body.action) || "profile";

    if (action === "retry-intent") {
      const intentKey = text(body.intentKey);
      const intent = getCopyTradeIntent(intentKey);
      if (!intent) return response("Copy-trade intent not found.", 404);
      if (intent.status !== "failed") {
        throw new Error("Only failed intents can be retried.");
      }
      return response(
        updateCopyTradeIntent(intent.intentKey, {
          status: "queued",
          reason: null,
          attempts: 0,
          nextAttemptAtMs: 0,
          updatedAtMs: Date.now(),
        }),
      );
    }

    const profileKey = text(body.profileKey);
    const existing = getCopyTradeProfile(profileKey);
    if (!existing) return response("Copy-trade profile not found.", 404);

    if (action === "toggle") {
      const enabled = bool(body.enabled, Number(existing.enabled) <= 0);
      if (enabled && existing.mode === "live" && !liveSettings().liveReady) {
        throw new Error("Live execution is not globally configured.");
      }
      return response(
        upsertCopyTradeProfile({
          ...existing,
          enabled: enabled ? 1 : 0,
          updatedAtMs: Date.now(),
        }),
      );
    }

    return response(upsertCopyTradeProfile(profileInput(body, existing)));
  } catch (error) {
    return response(errorMessage(error), errorStatus(error));
  }
}

/** Profiles are retained for audit history; DELETE disables rather than erases. */
export async function DELETE(request: Request): Promise<Response> {
  try {
    assertWebAuth(request);
    const url = new URL(request.url);
    let profileKey = text(url.searchParams.get("profileKey"));
    if (!profileKey) {
      const body = await requestBody(request);
      profileKey = text(body.profileKey);
    }
    const existing = getCopyTradeProfile(profileKey);
    if (!existing) return response("Copy-trade profile not found.", 404);
    return response(
      upsertCopyTradeProfile({
        ...existing,
        enabled: 0,
        updatedAtMs: Date.now(),
      }),
    );
  } catch (error) {
    return response(errorMessage(error), errorStatus(error));
  }
}
