import type { Solard } from "../core/solard.ts";
import { createSolardMeasure } from "../core/log.ts";
import { measured } from "../core/measured.ts";
import type { MeteoraExecutionResult } from "../venues/meteora/index.ts";

const m = createSolardMeasure("meteora:liquidation");

export type RegistryMeteoraPosition = {
  walletName: string;
  walletAddress: string;
  pool: string;
  position: string;
  totalXRaw: string;
  totalYRaw: string;
  feeXRaw: string;
  feeYRaw: string;
};

export type RegistryMeteoraLiquidationPlan = {
  walletsScanned: number;
  positions: RegistryMeteoraPosition[];
  scanErrors: Array<{
    walletName: string;
    walletAddress: string;
    error: string;
  }>;
};

export type RegistryMeteoraLiquidationResult = {
  position: RegistryMeteoraPosition;
  result?: MeteoraExecutionResult;
  error?: string;
};

export type RegistryMeteoraLiquidationOptions = {
  walletRefs?: string[];
  delayMs?: number;
  continueOnError?: boolean;
};

const pause = (ms: number) =>
  ms > 0
    ? new Promise<void>((resolve) => setTimeout(resolve, ms))
    : Promise.resolve();

function selectedWallets(slrd: Solard, refs?: string[]) {
  const all = slrd.wallets.list();
  if (!refs?.length) return all;
  const addresses = new Set(
    refs.map((ref) => slrd.resolveWallet(ref).address.toBase58()),
  );
  return all.filter((wallet) => addresses.has(wallet.address));
}

export async function planRegistryMeteoraLiquidation(
  slrd: Solard,
  options: RegistryMeteoraLiquidationOptions = {},
): Promise<RegistryMeteoraLiquidationPlan> {
  const wallets = selectedWallets(slrd, options.walletRefs);
  const positions: RegistryMeteoraPosition[] = [];
  const scanErrors: RegistryMeteoraLiquidationPlan["scanErrors"] = [];
  const delayMs = Math.max(0, options.delayMs ?? 100);

  for (let index = 0; index < wallets.length; index += 1) {
    const wallet = wallets[index]!;
    try {
      const found = await measured(
        m,
        `scan-wallet ${index + 1}/${wallets.length} @${wallet.name}`,
        async () => await slrd.meteora.getWalletPositions(wallet.address),
        (result) => ({
          wallet: wallet.address,
          positions: result.totalPositions,
        }),
      );
      for (const row of found.positions) {
        if (!row.position || !row.pool) continue;
        positions.push({
          walletName: wallet.name,
          walletAddress: wallet.address,
          pool: row.pool,
          position: row.position,
          totalXRaw: String(row.totalXRaw ?? "0"),
          totalYRaw: String(row.totalYRaw ?? "0"),
          feeXRaw: String(row.feeXRaw ?? "0"),
          feeYRaw: String(row.feeYRaw ?? "0"),
        });
      }
    } catch (error) {
      scanErrors.push({
        walletName: wallet.name,
        walletAddress: wallet.address,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await pause(delayMs);
  }

  return { walletsScanned: wallets.length, positions, scanErrors };
}

export async function executeRegistryMeteoraLiquidation(
  slrd: Solard,
  plan: RegistryMeteoraLiquidationPlan,
  options: RegistryMeteoraLiquidationOptions = {},
): Promise<RegistryMeteoraLiquidationResult[]> {
  if (plan.scanErrors.length) {
    throw new Error(
      `Refusing Meteora liquidation because ${plan.scanErrors.length} wallet position scan(s) failed.`,
    );
  }
  const out: RegistryMeteoraLiquidationResult[] = [];
  const delayMs = Math.max(0, options.delayMs ?? 100);

  for (const position of plan.positions) {
    try {
      const prepared = await slrd.meteora.buildClosePosition({
        wallet: position.walletAddress,
        pool: position.pool,
        position: position.position,
      });
      const result = await measured(
        m,
        `close-position ${position.position}`,
        async () =>
          await slrd.meteora.executePreparedAndVerify(
            prepared,
            {
              live: true,
              simulate: true,
              skipPreflight: false,
              commitment: "confirmed",
            },
            { attempts: 6, retryDelayMs: 500, commitment: "confirmed" },
          ),
        (receipt) => ({
          pool: position.pool,
          position: position.position,
          signatures: receipt.signatures.length,
        }),
      );
      out.push({ position, result });
    } catch (error) {
      out.push({
        position,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!options.continueOnError) break;
    }
    await pause(delayMs);
  }

  const failed = out.filter((row) => row.error).length;
  if (failed) {
    throw new Error(
      `Meteora liquidation failed for ${failed} position(s); final sweep is blocked.`,
    );
  }

  const verification = await planRegistryMeteoraLiquidation(slrd, {
    walletRefs: options.walletRefs,
    delayMs,
  });
  if (verification.scanErrors.length || verification.positions.length) {
    throw new Error(
      `Meteora liquidation verification failed: remaining=${verification.positions.length}, scanErrors=${verification.scanErrors.length}. Final sweep is blocked.`,
    );
  }
  return out;
}
