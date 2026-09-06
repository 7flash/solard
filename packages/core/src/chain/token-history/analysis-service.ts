import { measure } from "../../core/log.ts";
import { measuredSync } from "../../core/measured.ts";
import { analyzeTokenHistoryTrades } from "./analysis.ts";
import {
  defaultTokenHistoryRepository,
  type TokenHistoryRepository,
} from "./repository.ts";
import type { TokenHistoryAnalysis } from "./types.ts";

const m = measure("history:analysis");

export function analyzeTokenHistoryWithRepository(
  repository: TokenHistoryRepository,
  mintInput: string,
  options: { ownedWallets?: Iterable<string> } = {},
): TokenHistoryAnalysis {
  const mint = mintInput.trim();
  return measuredSync(
    m,
    "analyze",
    () =>
      analyzeTokenHistoryTrades({
        mint,
        trades: repository.loadTrades(mint),
        coverage: repository.getCoverage(mint),
        ownedWallets: options.ownedWallets,
      }),
    (analysis) => ({
      mint: mint.slice(0, 8),
      trades: analysis.trades,
      traders: analysis.uniqueTraders,
      buys: analysis.buys,
      sells: analysis.sells,
    }),
  );
}

export function analyzeTokenHistory(
  mintInput: string,
  options: { ownedWallets?: Iterable<string> } = {},
): TokenHistoryAnalysis {
  return analyzeTokenHistoryWithRepository(
    defaultTokenHistoryRepository,
    mintInput,
    options,
  );
}
