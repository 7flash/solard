import { measure } from "../../core/log.ts";
import { measuredSync } from "../../core/measured.ts";
import { analyzeTokenHistoryForensics } from "./forensics.ts";
import {
  defaultTokenHistoryRepository,
  type TokenHistoryRepository,
} from "./repository.ts";
import type {
  TokenHistoryForensics,
  TokenHistoryForensicsOptions,
} from "./types.ts";

const m = measure("history:analysis");

export function analyzeTokenHistoryForensicsWithRepository(
  repository: TokenHistoryRepository,
  mintInput: string,
  options: TokenHistoryForensicsOptions & {
    ownedWallets?: Iterable<string>;
  } = {},
): TokenHistoryForensics {
  const mint = mintInput.trim();
  return measuredSync(
    m,
    "forensics",
    () =>
      analyzeTokenHistoryForensics({
        mint,
        trades: repository.loadTrades(mint),
        coverage: repository.getCoverage(mint),
        ownedWallets: options.ownedWallets,
        options,
      }),
    (result) => ({
      mint: mint.slice(0, 8),
      firstBuyers: result.firstBuyers.length,
      ownedWallets: result.ownedPnl.length,
      rankedTraders: result.topTotalWinners.length,
      periods: result.periods.length,
    }),
  );
}

export function analyzeTokenHistoryForensicsFromStore(
  mintInput: string,
  options: TokenHistoryForensicsOptions & {
    ownedWallets?: Iterable<string>;
  } = {},
): TokenHistoryForensics {
  return analyzeTokenHistoryForensicsWithRepository(
    defaultTokenHistoryRepository,
    mintInput,
    options,
  );
}
