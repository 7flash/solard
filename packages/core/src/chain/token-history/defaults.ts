import { type Connection, type PublicKey } from "@solana/web3.js";

import { readMint } from "../state.ts";
import { PumpCurveVenue } from "../../venues/pump/pump-curve-venue.ts";
import { systemTokenHistoryClock } from "./clock.ts";
import {
  defaultTokenHistoryRepository,
  type TokenHistoryRepository,
} from "./repository.ts";
import { SolanaTokenHistoryRpc } from "./rpc.ts";
import { runTokenHistoryBackfill } from "./service.ts";
import type {
  BackfillTokenHistoryOptions,
  TokenHistoryCoverage,
} from "./types.ts";

export async function backfillTokenHistory(
  connection: Connection,
  mintInput: string,
  input: BackfillTokenHistoryOptions = {},
  repository: TokenHistoryRepository = defaultTokenHistoryRepository,
): Promise<TokenHistoryCoverage> {
  const venue = new PumpCurveVenue();
  return runTokenHistoryBackfill(
    {
      clock: systemTokenHistoryClock,
      rpc: new SolanaTokenHistoryRpc(connection),
      repository,
      loadMint: (mint: PublicKey) => readMint(connection, mint),
      inspectMarket: async (mint: PublicKey) => {
        const row = await venue.inspectToken(connection, mint);
        return row
          ? {
              bondingCurve: row.bondingCurve ?? null,
              pool: row.pool ?? null,
              quoteMint: row.quoteMint ?? null,
            }
          : null;
      },
    },
    mintInput,
    input,
  );
}
