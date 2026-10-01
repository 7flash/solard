import type { SenderId, SendOptions } from "./types.ts";
import type { TradeLandingPolicy } from "./trade-policy.ts";
import type { TradeResult } from "./trade-result.ts";
export type TradeExecutionOptions = SendOptions & {
  landing?: TradeLandingPolicy; waitForConfirmation?: boolean;
  priorityFee?: { cuLimit?: number; microLamports?: number };
  via?: SenderId | SenderId[]; intentKey?: string;
  onSubmitted?: (signature: string) => void;
  onRebroadcast?: (signature: string) => void;
  onAttempt?: (attempt: number) => void;
  onSettled?: (result: TradeResult) => void;
};
export function notifyTrade(callback: (() => void) | undefined) { try { callback?.(); } catch {} }
