/** Estimate conversion at a small SOL notional, never a fixed number of expensive tokens. */
export async function probeQuoteSol(decimals: number, quote: (amount: bigint) => Promise<bigint>): Promise<number> {
  const scale = 10n ** BigInt(decimals);
  let amount = scale / 1000n || 1n;
  for (let attempt = 0; attempt < 4; attempt++) {
    const out = await quote(amount);
    if (out > 0n && out <= 50_000_000n && out >= 1_000_000n)
      return Number(out) / 1e9 / (Number(amount) / Number(scale));
    const next = out > 0n ? amount * 10_000_000n / out : amount * 1000n;
    amount = next > 0n ? next : 1n;
  }
  throw new Error("Small-notional quote-to-SOL conversion unavailable");
}
