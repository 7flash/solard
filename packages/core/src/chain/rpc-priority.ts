import { AsyncLocalStorage } from "async_hooks";
const foreground = new AsyncLocalStorage<boolean>();
/** Admission preference only. The existing provider and shared quotas still apply. */
export class RpcTradePriority {
  active = 0;
  private lastBackground = -Infinity;
  delay(isForeground: boolean, now: number): number {
    if (!this.active || isForeground) return 0;
    const remaining = 1100 - (now - this.lastBackground);
    if (remaining > 0) return remaining;
    this.lastBackground = now;
    return 0;
  }
}
const priority = new RpcTradePriority();
export async function withTradeRpcPriority<T>(task: () => Promise<T>): Promise<T> {
  if (process.env.SLRD_RPC_TRADE_PRIORITY !== "1" || foreground.getStore()) return task();
  priority.active++;
  try {
    let operation: Promise<T> | undefined;
    foreground.run(true, () => { operation = task(); });
    return await operation!;
  }
  finally { priority.active--; }
}
export async function waitForRpcPriority(): Promise<void> {
  if (process.env.SLRD_RPC_TRADE_PRIORITY !== "1") return;
  while (true) {
    const delay = priority.delay(foreground.getStore() === true, Date.now());
    if (!delay) return;
    await new Promise(resolve => setTimeout(resolve, Math.min(delay, 50)));
  }
}
