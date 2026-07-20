import {
  appendWalletSwapOnce,
  getTerminalToken,
  upsertWalletTransaction,
  upsertWatchedWallet,
} from "../shared/db.js";
import { compactId, dbMeasure, summarizeError } from "../shared/measure.js";
import type { ParsedWalletTransaction } from "./wallet-types.ts";
import type { WalletIndexerCounters } from "./wallet-types.ts";

function json(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    typeof item === "bigint" ? item.toString() : item,
  );
}

export async function applyWalletTransaction(
  parsed: ParsedWalletTransaction,
  counters: WalletIndexerCounters,
): Promise<{ insertedSwaps: number; duplicateSwaps: number }> {
  let insertedSwaps = 0;
  let duplicateSwaps = 0;

  for (const wallet of parsed.wallets) {
    dbMeasure.sync(
      {
        start: () =>
          `db.wallet_transaction wallet=${compactId(wallet)} signature=${compactId(parsed.signature)}`,
        end: (result: any) => ({
          status: result?.parseStatus,
          slot: result?.slot,
        }),
        catch: summarizeError,
      },
      () =>
        upsertWalletTransaction({
          wallet,
          signature: parsed.signature,
          slot: parsed.slot,
          confidence: parsed.confidence,
          parseStatus: parsed.swaps.some((swap) => swap.wallet === wallet)
            ? "parsed"
            : "ignored",
          parserVersion: "wallet-v1",
          rawJson: json(parsed.raw),
          tradedAtMs: parsed.tradedAtMs,
          updatedAtMs: Date.now(),
        }),
    );

    upsertWatchedWallet({
      address: wallet,
      lastSeenSlot: parsed.slot,
      updatedAtMs: Date.now(),
    });
  }

  for (const swap of parsed.swaps) {
    let marketCapUsd = swap.marketCapUsd;
    if (marketCapUsd == null && swap.priceUsd != null) {
      const token = getTerminalToken(swap.subjectMint);
      const supplyUi = Number(token?.supplyUi ?? 0);
      if (Number.isFinite(supplyUi) && supplyUi > 0) {
        marketCapUsd = swap.priceUsd * supplyUi;
      }
    }

    const write = dbMeasure.sync(
      {
        start: () =>
          `db.wallet_swap wallet=${compactId(swap.wallet)} mint=${compactId(swap.subjectMint)}`,
        end: (result: any) => ({
          inserted: result?.inserted === true,
          side: swap.side,
          parser: swap.parser,
        }),
        catch: summarizeError,
      },
      () =>
        appendWalletSwapOnce({
          eventKey: swap.eventKey,
          wallet: swap.wallet,
          signature: swap.signature,
          slot: swap.slot,
          inputMint: swap.inputMint,
          inputAmountUi: swap.inputAmountUi,
          outputMint: swap.outputMint,
          outputAmountUi: swap.outputAmountUi,
          subjectMint: swap.subjectMint,
          quoteMint: swap.quoteMint,
          side: swap.side,
          venue: swap.venue,
          programId: swap.programId,
          parser: swap.parser,
          classificationConfidence: swap.classificationConfidence,
          copyable: swap.copyable ? 1 : 0,
          priceSol: swap.priceSol,
          priceUsd: swap.priceUsd,
          marketCapUsd,
          rawJson: json(swap.raw),
          tradedAtMs: swap.tradedAtMs,
          updatedAtMs: Date.now(),
        }),
    );

    if (write.inserted) {
      insertedSwaps++;
      counters.parsedSwaps++;
      if (swap.parser === "pump-event") counters.pumpCurveSwaps++;
      else if (swap.parser === "pumpswap-instruction") counters.pumpSwaps++;
      else if (swap.parser === "owner-balance-delta") counters.inferredSwaps++;
    } else {
      duplicateSwaps++;
      counters.duplicateSwaps++;
    }

    counters.lastWallet = swap.wallet;
    counters.lastSignature = swap.signature;
    counters.lastSwapAtMs = swap.tradedAtMs;
  }

  counters.parsedTransactions++;
  if (!parsed.swaps.length) counters.ignoredTransactions++;
  if (!parsed.swaps.length) {
    counters.lastSignature = parsed.signature;
  }

  return { insertedSwaps, duplicateSwaps };
}
