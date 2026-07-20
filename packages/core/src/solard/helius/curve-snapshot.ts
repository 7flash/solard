import { Buffer } from "node:buffer";
import {
  applyTerminalCurveSnapshot,
  dbWrite,
  listTerminalCurveSnapshotCandidates,
  recomputeTerminalIndicators,
  upsertProcessStatus,
  type TerminalCurveSnapshotCandidate,
} from "@solard/core/db.js";
import { createMeasure, summarizeForMeasure } from "../measure.ts";
import {
  bondingCurveProgressPct,
  decodeBondingCurveAccount,
  deriveBondingCurvePda,
} from "../pump/pump-parser.ts";
import { resolveSolUsd } from "../prices/sol-usd.ts";

const curveMeasure = createMeasure("solard:curve");

export type CurveSnapshotResult = {
  checked: number;
  fetched: number;
  updated: number;
  missing: number;
  errors: number;
  solUsd: number | null;
};

function heliusRpcUrl(): string {
  const url =
    process.env.HELIUS_RPC_URL?.trim() || process.env.RPC_ENDPOINT?.trim();
  if (url) return url;
  const key = process.env.HELIUS_API_KEY?.trim();
  if (key)
    return `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`;
  return "https://api.mainnet-beta.solana.com";
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

function uniq<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function curveAddressFor(
  candidate: TerminalCurveSnapshotCandidate,
): string | null {
  const explicit = String(candidate.bondingCurveKey ?? "").trim();
  if (explicit) return explicit;
  return deriveBondingCurvePda(candidate.mint);
}

function toUi(baseUnits: bigint, decimals: number): number {
  return Number(baseUnits) / 10 ** decimals;
}

function calculateCurvePrice(input: {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  tokenTotalSupply: bigint;
  solUsd: number | null;
  fallbackSupplyUi?: number | null;
}): {
  priceSol: number | null;
  priceUsd: number | null;
  marketCapSol: number | null;
  marketCapUsd: number | null;
  supplyUi: number;
} {
  const virtualTokenUi = toUi(input.virtualTokenReserves, 6);
  const virtualSolUi = toUi(input.virtualSolReserves, 9);
  const supplyUi =
    Number.isFinite(Number(input.fallbackSupplyUi)) &&
    Number(input.fallbackSupplyUi) > 0
      ? Number(input.fallbackSupplyUi)
      : Math.max(1, toUi(input.tokenTotalSupply || 1_000_000_000_000_000n, 6));
  if (
    !Number.isFinite(virtualTokenUi) ||
    virtualTokenUi <= 0 ||
    !Number.isFinite(virtualSolUi) ||
    virtualSolUi <= 0
  ) {
    return {
      priceSol: null,
      priceUsd: null,
      marketCapSol: null,
      marketCapUsd: null,
      supplyUi,
    };
  }
  const priceSol = virtualSolUi / virtualTokenUi;
  const marketCapSol = priceSol * supplyUi;
  const priceUsd = input.solUsd != null ? priceSol * input.solUsd : null;
  const marketCapUsd =
    input.solUsd != null ? marketCapSol * input.solUsd : null;
  return { priceSol, priceUsd, marketCapSol, marketCapUsd, supplyUi };
}

async function getMultipleAccounts(
  addresses: string[],
): Promise<Map<string, Buffer | null>> {
  if (!addresses.length) return new Map();
  const res = await fetch(heliusRpcUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(
      Number(process.env.SOLARD_CURVE_SNAPSHOT_TIMEOUT_MS ?? "5000"),
    ),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "solard-curve-snapshot",
      method: "getMultipleAccounts",
      params: [addresses, { encoding: "base64", commitment: "processed" }],
    }),
  });
  if (!res.ok) throw new Error(`getMultipleAccounts failed: ${res.status}`);
  const payload = (await res.json()) as any;
  const values = Array.isArray(payload?.result?.value)
    ? payload.result.value
    : [];
  const out = new Map<string, Buffer | null>();
  addresses.forEach((address, index) => {
    const encoded = values[index]?.data?.[0];
    out.set(
      address,
      typeof encoded === "string" ? Buffer.from(encoded, "base64") : null,
    );
  });
  return out;
}

export async function refreshTerminalCurveSnapshots(
  args: {
    limit?: number;
    source?: string | null;
    activeWindowMs?: number;
  } = {},
): Promise<CurveSnapshotResult> {
  return await curveMeasure.measure(
    {
      start: () => "refresh terminal curve snapshots",
      end: (result) => ({ result: summarizeForMeasure(result) }),
      catch: (error) => {
        upsertProcessStatus({
          name: "solard-curve-snapshots",
          kind: "snapshot",
          status: "error",
          error,
          data: { phase: "refresh", source: args.source ?? null },
        });
        throw error;
      },
    },
    async () => {
      const candidates = listTerminalCurveSnapshotCandidates(args);
      const byCurve = new Map<string, TerminalCurveSnapshotCandidate>();
      for (const candidate of candidates) {
        const curve = curveAddressFor(candidate);
        if (!curve) continue;
        byCurve.set(curve, { ...candidate, bondingCurveKey: curve });
      }
      const solUsd = await resolveSolUsd({ timeoutMs: 1500 }).catch(() => null);
      const result: CurveSnapshotResult = {
        checked: candidates.length,
        fetched: byCurve.size,
        updated: 0,
        missing: 0,
        errors: 0,
        solUsd,
      };
      for (const addresses of chunk(uniq([...byCurve.keys()]), 100)) {
        let accounts: Map<string, Buffer | null>;
        try {
          accounts = await getMultipleAccounts(addresses);
        } catch (error) {
          result.errors += addresses.length;
          upsertProcessStatus({
            name: "solard-curve-snapshots",
            kind: "snapshot",
            status: "rpc-error",
            error,
            data: { addresses: addresses.length },
          });
          continue;
        }
        for (const address of addresses) {
          const candidate = byCurve.get(address);
          const buffer = accounts.get(address);
          if (!candidate || !buffer) {
            result.missing++;
            continue;
          }
          const curve = decodeBondingCurveAccount(buffer);
          if (!curve) {
            result.errors++;
            continue;
          }
          const quote = calculateCurvePrice({
            virtualTokenReserves: curve.virtualTokenReserves,
            virtualSolReserves: curve.virtualSolReserves,
            tokenTotalSupply: curve.tokenTotalSupply,
            solUsd,
            fallbackSupplyUi: candidate.supplyUi,
          });
          const now = Date.now();
          await dbWrite("curve_snapshot_token", () =>
            applyTerminalCurveSnapshot({
              mint: candidate.mint,
              bondingCurveKey: address,
              source: candidate.source?.includes("pumpportal")
                ? "pumpportal-curve"
                : "helius-curve",
              priceSol: quote.priceSol,
              priceUsd: quote.priceUsd,
              marketCapSol: quote.marketCapSol,
              marketCapUsd: quote.marketCapUsd,
              realTokenReservesUi: toUi(curve.realTokenReserves, 6),
              realSolReservesUi: toUi(curve.realSolReserves, 9),
              virtualTokenReservesUi: toUi(curve.virtualTokenReserves, 6),
              virtualSolReservesUi: toUi(curve.virtualSolReserves, 9),
              progressPct: bondingCurveProgressPct(curve),
              complete: curve.complete,
              creator: curve.creator,
              now,
            }),
          );
          await dbWrite("curve_snapshot_indicators", () =>
            recomputeTerminalIndicators(candidate.mint, now),
          );
          result.updated++;
        }
      }
      upsertProcessStatus({
        name: "solard-curve-snapshots",
        kind: "snapshot",
        status: "ok",
        data: result,
      });
      return result;
    },
  );
}
