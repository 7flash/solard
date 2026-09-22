import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const controller = readFileSync(
  join(import.meta.dir, "position-controller.ts"),
  "utf8",
);
const service = readFileSync(
  join(import.meta.dir, "../packages/core/src/venues/raydium/service.ts"),
  "utf8",
);

function section(
  source: string,
  startNeedle: string,
  endNeedle: string,
): string {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  if (start < 0 || end < 0)
    throw new Error(`missing ${startNeedle}..${endNeedle}`);
  return source.slice(start, end);
}

describe("Raydium durable submission", () => {
  test("service exposes submitPrepared without confirmation", () => {
    const body = section(
      service,
      "async submitPrepared(",
      "async executePrepared(",
    );
    expect(body).toContain("sendRawTransaction(");
    expect(body).toContain("signatures.push(signature)");
    expect(body).not.toContain("confirmTransaction(");
  });

  test("controller uses submitPrepared for Raydium swaps", () => {
    const body = section(
      controller,
      "const prepared = await args.raydium.buildSwapExactIn({",
      "function keyString",
    );
    expect(body).toContain("args.raydium.submitPrepared(prepared");
    expect(body).not.toContain("args.raydium.executePrepared(prepared");
    expect(body).toContain("recentBlockhash");
    expect(body).toContain("estimatedNetworkFeeLamports");
  });

  test("controller refuses multi-transaction Raydium swaps before send", () => {
    expect(controller).toContain("prepared.transactions.length !== 1");
    expect(controller).toContain(
      "settlement currently requires exactly one swap transaction",
    );
  });

  test("Raydium pending can expire using blockhash validity", () => {
    expect(controller).toContain("connection.isBlockhashValid(");
    expect(controller).toContain("settlement.blockhash-expired-unseen");
  });

  test("explicit signature recovery is transaction-metadata based and deduped", () => {
    expect(controller).toContain('flag(flags, "recover-signature")');
    expect(controller).toContain(
      "explicit-signature-transaction-metadata-recovery",
    );
    expect(controller).toContain("lastSettledSignature");
    expect(controller).toContain('flags.has("recover-only")');
  });

  test("pre-send Raydium simulation classification remains", () => {
    expect(controller).toContain("isRaydiumPreSubmissionFailure");
    expect(controller).toContain('markSubmissionAmbiguous(error, "raydium")');
  });
});
