import type { TokenHistoryClock } from "./types.ts";

export const systemTokenHistoryClock: TokenHistoryClock = Object.freeze({
  nowMs: () => Date.now(),
});
