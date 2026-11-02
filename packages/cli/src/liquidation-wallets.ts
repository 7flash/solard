/** Retry reads only. An execution callback is never repeated by this runner. */
export async function retryLiquidationRead<T>(
  read: () => Promise<T>,
  onRetry: (attempt: number, delayMs: number) => void,
  sleep: (ms: number) => Promise<unknown> = ms => Bun.sleep(ms),
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await read(); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= 6 || !/RPC_PROVIDER_UNAVAILABLE|RPC_QUEUE_TIMEOUT|RPC_TIMEOUT|429|rate.limit|fetch failed|ECONNRESET|timed? ?out/i.test(message)) throw error;
      const delayMs = Math.min(60_000, 5_000 * 2 ** attempt);
      onRetry(attempt + 1, delayMs);
      await sleep(delayMs);
    }
  }
}

export async function runLiquidationWallets(
  wallets: string[],
  run: (wallet: string) => Promise<unknown>,
  onStart: (wallet: string, index: number, total: number) => void,
  onFailure: (wallet: string, error: unknown) => void,
): Promise<string[]> {
  const failures: string[] = [];
  const unique = [...new Set(wallets)];
  for (const [index, wallet] of unique.entries()) {
    onStart(wallet, index + 1, unique.length);
    try { await run(wallet); }
    catch (error) { failures.push(wallet); onFailure(wallet, error); }
  }
  return failures;
}
