import type { SenderId, SendOptions } from "./types.ts";
import type { TradeLandingPolicy } from "./trade-policy.ts";
import type { TradeResult } from "./trade-result.ts";
import { withTradeRpcPriority } from "../chain/rpc-priority.ts";
export type TradeExecutionOptions = SendOptions & {
  /** Absolute final output floor: token raw units for buys, lamports for sells. */
  outputMinimumRaw?: bigint | string;
  landing?: TradeLandingPolicy;
  waitForConfirmation?: boolean;
  priorityFee?: { cuLimit?: number; microLamports?: number };
  via?: SenderId | SenderId[];
  intentKey?: string;
  /** Simulation sizing is opt-in; existing explicit priorityFee.cuLimit stays fixed. */
  computeUnits?: "auto";
  computeUnitMultiplier?: number;
  confirm?: {
    resendIntervalMs?: number;
    pollIntervalMs?: number;
    timeoutMs?: number;
  };
  heliusTier?: "helius-swqos" | "helius-max";
  onStage?: (stage: string, durationMs: number) => void;
  onSubmitted?: (signature: string) => void;
  onRebroadcast?: (signature: string) => void;
  onAttempt?: (attempt: number) => void;
  onSettled?: (result: TradeResult) => void;
};
export function notifyTrade(callback: (() => void) | undefined) {
  try {
    callback?.();
  } catch {}
}

/** Stage timings include failed calls and never alter their outcome. */
export async function timeTradeStage<T>(options: Pick<TradeExecutionOptions, "onStage">, stage: string, task: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try { return await (["build-route-and-plan", "fees-and-final-compile", "preflight-and-broadcast", "prepared-broadcast"].includes(stage) ? withTradeRpcPriority(task) : task()); }
  finally { notifyTrade(() => options.onStage?.(stage, Math.round(performance.now() - started))); }
}
