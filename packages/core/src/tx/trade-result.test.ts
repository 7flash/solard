import { expect, test } from "bun:test";
import { failedTrade, tradeResult } from "./trade-result.ts";
import { TradePreSubmissionError } from "./trade-errors.ts";
import { PriceGuardRejected } from "./price-guard.ts";

test("named venue slippage failures permit a fresh quote", () => {
  for (const name of [
    "BuySlippageBelowMinTokensOut",
    "SellSlippageBelowMinSolOut",
    "BuySlippageBelowMinBaseAmountOut",
    "SellSlippageBelowMinQuoteAmountOut",
    "ExceededSlippage",
    "TooLittleSolReceived",
  ]) {
    const result = failedTrade(
      new Error(`Error Code: ${name}. Error Number: 6042.`),
    );
    expect(result).toMatchObject({
      status: "failed",
      phase: "before-submission",
      code: "SLIPPAGE",
      retryable: true,
      programErrorName: name,
      programErrorNumber: 6042,
    });
  }
});

test("nested simulation logs retain decoded slippage identity", () => {
  const cause = Object.assign(new Error('Simulation failed: {"Custom":6042}'), {
    logs: [
      "Program log: AnchorError. Error Code: BuySlippageBelowMinTokensOut. Error Number: 6042.",
    ],
  });
  expect(failedTrade(new TradePreSubmissionError(cause))).toMatchObject({
    code: "SLIPPAGE",
    retryable: true,
    programErrorNumber: 6042,
  });
});

test("unidentified numeric errors do not imply venue slippage", () => {
  for (const message of ['{"Custom":6042}', "custom program error: 0x179a"]) {
    expect(failedTrade(new Error(message))).toMatchObject({
      code: "PROGRAM_ERROR",
      retryable: false,
      programErrorNumber: 6042,
    });
  }
  expect(failedTrade(new PriceGuardRejected("buy", "0.1"))).toMatchObject({
    code: "PRICE_GUARD_REJECTED",
    retryable: true,
  });
});

test("uncertain submissions never permit retry even when error mentions slippage", () => {
  const receipt = {
    signature: "original",
    sender: "rpc",
    slot: null,
    error: "TooLittleSolReceived",
    retryable: true,
  } as const;
  expect(tradeResult({ ...receipt, status: "submitted" })).toMatchObject({
    status: "unresolved",
    code: "UNRESOLVED",
    retryable: false,
  });
  expect(
    tradeResult({ ...receipt, status: "failed", retryable: false }),
  ).toMatchObject({
    status: "failed",
    phase: "on-chain",
    code: "SLIPPAGE",
    retryable: true,
  });
});
