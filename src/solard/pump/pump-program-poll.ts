import {
  Connection,
  PublicKey,
  type ConfirmedSignatureInfo,
} from "@solana/web3.js";
import {
  measureRetry,
  workerMeasure,
  summarizeForMeasure,
} from "../measure.js";
import { getCursor, setCursor } from "../../../shared/db.js";
import { hasIngestionKey } from "../db/terminal-ingestion.js";
import { PUMP_PROGRAM_ID } from "./parse-terminal-tx.js";

export type SignaturePollBatch = {
  signatures: ConfirmedSignatureInfo[];
  newestSignature: string | null;
  previousNewestSignature: string | null;
  freshCount: number;
  skippedSeen: number;
};

export function pollLimit(
  envName: string,
  fallback: number,
  max = 100,
): number {
  return Math.max(
    1,
    Math.min(Number(process.env[envName] ?? String(fallback)), max),
  );
}

/**
 * Poll the current head of the pump.fun program signature list.
 *
 * Important: do not use `before` for live polling. `before` walks backwards into
 * history, so a worker that stores the newest signature as `before` will never
 * see future signatures. We poll the latest N signatures each tick and use a
 * SQLite de-dupe table plus a newest cursor to process only fresh rows.
 */
export async function pollLatestPumpSignatures(args: {
  connection: Connection;
  workerName: string;
  kind: string;
  limit: number;
  includeUntilPreviousNewest?: boolean;
}): Promise<SignaturePollBatch> {
  return await workerMeasure.measure(
    {
      start: () => `poll latest pump signatures ${args.workerName}`,
      end: (result) => ({ result: summarizeForMeasure(result) }),
    },
    async () => {
      const previousNewestSignature = getCursor(`${args.workerName}:newest`);
      const rows = await measureRetry(
        `${args.workerName}.getSignaturesForAddress.latest`,
        { attempts: 4, delay: 150, backoff: 2 },
        () =>
          args.connection.getSignaturesForAddress(
            new PublicKey(PUMP_PROGRAM_ID),
            { limit: args.limit },
          ),
      );
      if (!rows.length) {
        return {
          signatures: [],
          newestSignature: previousNewestSignature,
          previousNewestSignature,
          freshCount: 0,
          skippedSeen: 0,
        };
      }

      const newestSignature = rows[0]!.signature;
      const fresh: ConfirmedSignatureInfo[] = [];
      let skippedSeen = 0;
      for (const row of rows) {
        if (
          !args.includeUntilPreviousNewest &&
          previousNewestSignature &&
          row.signature === previousNewestSignature
        )
          break;
        const key = `${args.kind}:${row.signature}`;
        if (hasIngestionKey(key)) {
          skippedSeen++;
          continue;
        }
        fresh.push(row);
      }

      // Process old -> new, so UI rows and indicators move forward naturally.
      const ordered = [...fresh].reverse();
      setCursor(`${args.workerName}:newest`, newestSignature);
      return {
        signatures: ordered,
        newestSignature,
        previousNewestSignature,
        freshCount: ordered.length,
        skippedSeen,
      };
    },
  );
}
