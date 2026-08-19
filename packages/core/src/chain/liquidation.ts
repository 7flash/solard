import { NATIVE_MINT } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";

import type { Solard } from "../core/solard.ts";
import type { TokenRow } from "../db/schema.ts";
import type { SendReceipt, SenderId, SimulationResult } from "../tx/types.ts";
import {
  loadWalletAssetPortfolio,
  type WalletTokenHolding,
} from "./portfolio.ts";
import {
  executeJupiterTokenToSol,
  quoteJupiterTokenToSol,
  type JupiterSwapExecuteResult,
  type JupiterSwapQuote,
} from "./jupiter-swap.ts";

export type RegistryTokenLiquidationActionKind =
  | "sell"
  | "jupiter-sell"
  | "unwrap-wsol"
  | "keep-protected"
  | "skip-unsupported";

export type RegistryTokenLiquidationAction = {
  kind: RegistryTokenLiquidationActionKind;
  walletName: string;
  walletAddress: string;
  mint: string;
  name: string | null;
  symbol: string | null;
  decimals: number;
  amountRaw: bigint;
  amountUi: string;
  venue?: string;
  reason?: string;
  jupiterQuote?: JupiterSwapQuote;
  /** Ephemeral routing metadata; never contains secret key material. */
  token?: TokenRow;
};

export type RegistryTokenLiquidationPlan = {
  protectedMints: string[];
  actions: RegistryTokenLiquidationAction[];
  totals: {
    wallets: number;
    sell: number;
    jupiterSell: number;
    unwrapWsol: number;
    keepProtected: number;
    skipUnsupported: number;
  };
};

export type RegistryTokenLiquidationProgress =
  | { stage: "portfolio-start" }
  | {
      stage: "portfolio-done";
      wallets: number;
      holdings: number;
      distinctMints: number;
    }
  | {
      stage: "route";
      index: number;
      total: number;
      mint: string;
    }
  | {
      stage: "action-start";
      index: number;
      total: number;
      action: RegistryTokenLiquidationAction;
    }
  | {
      stage: "action-done";
      index: number;
      total: number;
      action: RegistryTokenLiquidationAction;
    }
  | {
      stage: "action-error";
      index: number;
      total: number;
      action: RegistryTokenLiquidationAction;
      error: string;
    };

export type RegistryTokenLiquidationOptions = {
  except?: string[];
  walletRefs?: string[];
  slippageBps?: number;
  via?: SenderId;
  delayMs?: number;
  routeDelayMs?: number;
  portfolioConcurrency?: number;
  portfolioDelayMs?: number;
  /** Try Jupiter Swap V2 for holdings unsupported by native Solard venues. */
  jupiterFallback?: boolean;
  onProgress?: (event: RegistryTokenLiquidationProgress) => void;
};

export type RegistryTokenLiquidationResult = {
  action: RegistryTokenLiquidationAction;
  simulation?: SimulationResult;
  receipt?: SendReceipt;
  jupiter?: JupiterSwapExecuteResult | JupiterSwapQuote;
  error?: string;
};

const pause = (ms: number) =>
  ms > 0
    ? new Promise<void>((resolve) => setTimeout(resolve, ms))
    : Promise.resolve();

function isPublicKey(value: string): boolean {
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Policy-facing token resolution is intentionally a little friendlier than
 * TokenRepo.resolve(). "slrd" is accepted as shorthand for the registered
 * SOLARD token symbol, while raw mint addresses always work.
 */
export function resolveTokenMintForPolicy(slrd: Solard, ref: string): string {
  const value = ref.trim().replace(/^\$/, "");
  if (!value) throw new Error("Token reference is required.");

  if (isPublicKey(value)) return new PublicKey(value).toBase58();

  try {
    return slrd.resolveToken(value).mint;
  } catch {
    // Continue with case-insensitive/read-only fallback below.
  }

  const lowered = value.toLowerCase();
  const aliases =
    lowered === "slrd" ? new Set(["slrd", "solard"]) : new Set([lowered]);

  const match = slrd.tokens.list().find((row) => {
    const name = String(row.name ?? "")
      .replace(/^\$/, "")
      .toLowerCase();
    const symbol = String(row.symbol ?? "")
      .replace(/^\$/, "")
      .toLowerCase();
    return aliases.has(name) || aliases.has(symbol);
  });

  if (match) return match.mint;

  throw new Error(
    `Unknown token policy reference "${ref}". Use a registered token name/symbol or raw mint address.`,
  );
}

function aggregateHoldings(
  holdings: WalletTokenHolding[],
): WalletTokenHolding[] {
  const byMint = new Map<string, WalletTokenHolding>();
  for (const holding of holdings) {
    if (holding.amountRaw <= 0n) continue;
    const existing = byMint.get(holding.mint);
    if (existing) {
      existing.amountRaw += holding.amountRaw;
      // amountUi is presentation only; recompute below.
      existing.amountUi = formatRaw(existing.amountRaw, existing.decimals);
    } else {
      byMint.set(holding.mint, { ...holding });
    }
  }
  return [...byMint.values()];
}

function formatRaw(raw: bigint, decimals: number): string {
  if (decimals <= 0) return raw.toString();
  const unit = 10n ** BigInt(decimals);
  const whole = raw / unit;
  const fraction = (raw % unit)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""}`;
}

function ephemeralToken(
  holding: WalletTokenHolding,
  inspected: Partial<TokenRow> | null,
): TokenRow {
  return {
    mint: holding.mint,
    decimals: holding.decimals,
    baseTokenProgram: holding.programId,
    ...(inspected ?? {}),
  } as TokenRow;
}

export async function planRegistryTokenLiquidation(
  slrd: Solard,
  options: RegistryTokenLiquidationOptions = {},
): Promise<RegistryTokenLiquidationPlan> {
  const protectedMints = new Set(
    (options.except ?? []).map((ref) => resolveTokenMintForPolicy(slrd, ref)),
  );

  options.onProgress?.({ stage: "portfolio-start" });
  const portfolio = await loadWalletAssetPortfolio(slrd, {
    walletRefs: options.walletRefs,
    concurrency: options.portfolioConcurrency ?? 1,
    requestDelayMs: options.portfolioDelayMs ?? 100,
  });
  options.onProgress?.({
    stage: "portfolio-done",
    wallets: portfolio.rows.length,
    holdings: portfolio.tokenHoldingCount,
    distinctMints: portfolio.distinctTokenCount,
  });

  const routeDelayMs = Math.max(0, options.routeDelayMs ?? 100);
  const mintRoutes = new Map<
    string,
    {
      token?: TokenRow;
      venue?: string;
      jupiterQuote?: JupiterSwapQuote;
      error?: string;
    }
  >();

  // Resolve each distinct non-protected/non-WSOL mint once. This is read-only:
  // no TokenRepo upserts, so liquidation planning does not rewrite metadata.
  const routeCandidates = new Map<string, WalletTokenHolding>();
  for (const row of portfolio.rows) {
    for (const holding of aggregateHoldings(row.tokenHoldings)) {
      if (
        protectedMints.has(holding.mint) ||
        holding.mint === NATIVE_MINT.toBase58()
      ) {
        continue;
      }
      const existing = routeCandidates.get(holding.mint);
      if (!existing || holding.amountRaw > existing.amountRaw) {
        routeCandidates.set(holding.mint, holding);
      }
    }
  }

  let routeIndex = 0;
  for (const holding of routeCandidates.values()) {
    routeIndex += 1;
    options.onProgress?.({
      stage: "route",
      index: routeIndex,
      total: routeCandidates.size,
      mint: holding.mint,
    });
    let nativeError: string | null = null;
    try {
      const mint = new PublicKey(holding.mint);
      const inspected = await slrd.venues.inspect(slrd.connection(), mint);
      const token = ephemeralToken(holding, inspected);
      const routed = await slrd.route(token, PublicKey.default);
      mintRoutes.set(holding.mint, {
        token,
        venue: String(routed.market.venue),
      });
    } catch (error) {
      nativeError = error instanceof Error ? error.message : String(error);
    }

    if (!mintRoutes.has(holding.mint) && options.jupiterFallback !== false) {
      try {
        const jupiterQuote = await quoteJupiterTokenToSol({
          inputMint: holding.mint,
          amountRaw: holding.amountRaw,
        });
        mintRoutes.set(holding.mint, {
          venue: `jupiter:${jupiterQuote.router ?? "auto"}`,
          jupiterQuote,
        });
      } catch (error) {
        const jupiterError =
          error instanceof Error ? error.message : String(error);
        mintRoutes.set(holding.mint, {
          error: nativeError
            ? `${nativeError}; Jupiter: ${jupiterError}`
            : `Jupiter: ${jupiterError}`,
        });
      }
    } else if (!mintRoutes.has(holding.mint)) {
      mintRoutes.set(holding.mint, {
        error: nativeError ?? "No supported Solard trading venue",
      });
    }
    await pause(routeDelayMs);
  }

  const actions: RegistryTokenLiquidationAction[] = [];
  for (const row of portfolio.rows) {
    for (const holding of aggregateHoldings(row.tokenHoldings)) {
      const common = {
        walletName: row.walletName,
        walletAddress: row.walletAddress,
        mint: holding.mint,
        name: holding.name,
        symbol: holding.symbol,
        decimals: holding.decimals,
        amountRaw: holding.amountRaw,
        amountUi: holding.amountUi,
      };

      if (protectedMints.has(holding.mint)) {
        actions.push({ ...common, kind: "keep-protected" });
        continue;
      }

      if (holding.mint === NATIVE_MINT.toBase58()) {
        actions.push({
          ...common,
          kind: "unwrap-wsol",
          name: "Wrapped SOL",
          symbol: "WSOL",
        });
        continue;
      }

      const route = mintRoutes.get(holding.mint);
      if (route?.token && route.venue) {
        actions.push({
          ...common,
          kind: "sell",
          token: route.token,
          venue: route.venue,
        });
      } else if (route?.jupiterQuote) {
        actions.push({
          ...common,
          kind: "jupiter-sell",
          venue: route.venue ?? "jupiter",
          jupiterQuote: route.jupiterQuote,
        });
      } else {
        actions.push({
          ...common,
          kind: "skip-unsupported",
          reason: route?.error ?? "No supported Solard trading venue",
        });
      }
    }
  }

  const count = (kind: RegistryTokenLiquidationActionKind) =>
    actions.filter((action) => action.kind === kind).length;

  return {
    protectedMints: [...protectedMints],
    actions,
    totals: {
      wallets: portfolio.rows.length,
      sell: count("sell"),
      jupiterSell: count("jupiter-sell"),
      unwrapWsol: count("unwrap-wsol"),
      keepProtected: count("keep-protected"),
      skipUnsupported: count("skip-unsupported"),
    },
  };
}

async function simulateAction(
  slrd: Solard,
  action: RegistryTokenLiquidationAction,
  options: RegistryTokenLiquidationOptions,
): Promise<RegistryTokenLiquidationResult> {
  try {
    if (action.kind === "sell") {
      if (!action.token) throw new Error("Missing routed token metadata");
      const plan = await slrd
        .tx(action.walletAddress)
        .sell(action.token, {
          bps: 10_000,
          slippageBps: options.slippageBps ?? 1_500,
        })
        .build();
      return { action, simulation: await slrd.simulatePlan(plan) };
    }

    if (action.kind === "jupiter-sell") {
      const quote = await quoteJupiterTokenToSol({
        inputMint: action.mint,
        amountRaw: action.amountRaw,
      });
      return { action, jupiter: quote };
    }

    if (action.kind === "unwrap-wsol") {
      const plan = await slrd
        .tx(action.walletAddress)
        .unwrapWsol({ skipMissing: true })
        .build();
      return { action, simulation: await slrd.simulatePlan(plan) };
    }

    return { action };
  } catch (error) {
    return {
      action,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function simulateRegistryTokenLiquidation(
  slrd: Solard,
  plan: RegistryTokenLiquidationPlan,
  options: RegistryTokenLiquidationOptions = {},
): Promise<RegistryTokenLiquidationResult[]> {
  const out: RegistryTokenLiquidationResult[] = [];
  const delayMs = Math.max(0, options.delayMs ?? 150);

  const executable = plan.actions.filter(
    (action) =>
      action.kind === "sell" ||
      action.kind === "jupiter-sell" ||
      action.kind === "unwrap-wsol",
  );
  for (let index = 0; index < executable.length; index += 1) {
    const action = executable[index]!;
    options.onProgress?.({
      stage: "action-start",
      index: index + 1,
      total: executable.length,
      action,
    });
    const result = await simulateAction(slrd, action, options);
    out.push(result);
    if (result.error) {
      options.onProgress?.({
        stage: "action-error",
        index: index + 1,
        total: executable.length,
        action,
        error: result.error,
      });
    } else {
      options.onProgress?.({
        stage: "action-done",
        index: index + 1,
        total: executable.length,
        action,
      });
    }
    await pause(delayMs);
  }
  return out;
}

export async function executeRegistryTokenLiquidation(
  slrd: Solard,
  plan: RegistryTokenLiquidationPlan,
  options: RegistryTokenLiquidationOptions = {},
): Promise<RegistryTokenLiquidationResult[]> {
  const out: RegistryTokenLiquidationResult[] = [];
  const delayMs = Math.max(0, options.delayMs ?? 250);
  const via = options.via ?? "rpc";

  const executable = plan.actions.filter(
    (action) =>
      action.kind === "sell" ||
      action.kind === "jupiter-sell" ||
      action.kind === "unwrap-wsol",
  );

  for (let index = 0; index < executable.length; index += 1) {
    const action = executable[index]!;
    options.onProgress?.({
      stage: "action-start",
      index: index + 1,
      total: executable.length,
      action,
    });

    try {
      if (action.kind === "sell") {
        if (!action.token) throw new Error("Missing routed token metadata");
        const receipt = await slrd
          .tx(action.walletAddress)
          .sell(action.token, {
            bps: 10_000,
            slippageBps: options.slippageBps ?? 1_500,
          })
          .send({
            via,
            kind: "registry-token-liquidation",
            skipSimulation: false,
            skipPreflight: false,
          });
        out.push({ action, receipt });
      } else if (action.kind === "jupiter-sell") {
        const jupiter = await executeJupiterTokenToSol({
          inputMint: action.mint,
          amountRaw: action.amountRaw,
          signer: slrd.signer(action.walletAddress),
        });
        out.push({ action, jupiter });
      } else {
        const receipt = await slrd.unwrapWsol(action.walletAddress, {
          via,
          skipMissing: true,
          skipSimulation: false,
          skipPreflight: false,
        });
        out.push({ action, receipt });
      }

      options.onProgress?.({
        stage: "action-done",
        index: index + 1,
        total: executable.length,
        action,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      out.push({ action, error: message });
      options.onProgress?.({
        stage: "action-error",
        index: index + 1,
        total: executable.length,
        action,
        error: message,
      });
    }

    await pause(delayMs);
  }

  return out;
}
