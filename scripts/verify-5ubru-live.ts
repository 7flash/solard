/** Explicit read-only public SDK acceptance; no private keys, no sending. */
import { PublicKey } from "@solana/web3.js";
import { createSolard } from "@solard/sdk";
const MINT = "5ubruMYpgKqw9ip5J1qrXbVGmMdn2VCsMg421B4bpump";
const QUOTE = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
const POOL = "DBzf8tQ3mTLSdGMLcDj1YA7E8HqAtq22JaFqma92Fi4";
if (process.env.SOLARD_5UBRU_READ_ONLY !== "1")
  throw new Error("Explicit SOLARD_5UBRU_READ_ONLY=1 required");
const address = process.env.SOLARD_PUBLIC_WALLET;
if (!address) throw new Error("Set SOLARD_PUBLIC_WALLET to a public address only");
const payer = new PublicKey(address);
const sdk = createSolard({});
const record = (kind: string, data: unknown) => process.stdout.write(JSON.stringify({ kind, data },
  (_key, value) => typeof value === "bigint" ? value.toString() : value) + "\n");
const failure = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const status = /\b429\b|Too Many Requests/i.test(message) ? "rate-limited" :
    /\b403\b|Request blocked/i.test(message) ? "provider-blocked" :
    /TRANSACTION_TOO_LARGE|encoding overruns/i.test(message) ? "oversized" : "failed";
  return { status, code: (error as { code?: string })?.code ?? null };
};
let errors = 0;
try {
  const current = await sdk.resolveCurrentMarket(MINT);
  if (!current || current.pool !== POOL || current.quoteMint !== QUOTE ||
      current.baseDecimals !== 6 || current.quoteDecimals !== 6)
    throw new Error("Mainnet target pool metadata changed or unavailable");
  record("market", current);
} catch (error) { errors++; record("market-failure", failure(error)); }

// The build/simulation stage is independent of the live feed, so a provider's
// WebSocket or event-conversion failure cannot conceal transaction diagnostics.
try {
  const { plan, simulation } = await sdk.simulateUnsignedBuy({
    payer, mint: MINT, sol: "0.001", slippageBps: 500,
  });
  if (plan.serializedSize > 1232 ||
      !plan.transaction.signatures.every(signature => signature.every(byte => byte === 0)))
    throw new Error("Plan too large or unexpectedly signed");
  record("unsigned-plan", { serializedSize: plan.serializedSize,
    actions: plan.draft.actions.map(action => action.meta),
    tables: plan.lookupTables.map(table => table.key.toBase58()) });
  record("simulation", { success: simulation.success, error: simulation.error,
    accountChanges: simulation.accountChanges, tokenChanges: simulation.tokenChanges,
    logs: simulation.logs, cuUsed: simulation.cuUsed, diagnostics: simulation.diagnostics });
  if (!simulation.success) errors++;
} catch (error) { errors++; record("buy-failure", failure(error)); }

let listener: Awaited<ReturnType<typeof sdk.listenTrades>> | undefined;
let unsubscribe: (() => void) | undefined;
try {
  const trades: unknown[] = [];
  listener = await sdk.listenTrades({ tokens: [MINT], history: false });
  unsubscribe = listener.onTrade(event => {
    if (event.mint !== MINT || event.pool !== POOL || event.market.quoteMint !== QUOTE) return;
    const market = event.market;
    if (market.priceSol == null || market.priceUsd == null || market.marketCapUsd == null) return;
    const expectedCap = market.priceUsd * Number(market.supplyRaw) / 10 ** market.baseDecimals;
    if (Math.abs(expectedCap - market.marketCapUsd) > Math.max(1e-6, expectedCap * 1e-9)) return;
    trades.push({ signature: event.signature, priceSol: market.priceSol,
      priceUsd: market.priceUsd, marketCapUsd: market.marketCapUsd,
      supplyRaw: market.supplyRaw.toString() });
  });
  const deadline = Date.now() + 30_000;
  while (!trades.length && Date.now() < deadline) await Bun.sleep(250);
  if (!trades.length) throw new Error("No fresh converted trade observed");
  record("live-event", trades[0]);
} catch (error) { errors++; record("feed-failure", failure(error)); }
finally {
  unsubscribe?.();
  if (listener) await listener.close().catch(() => {});
  sdk.close();
}
record("acceptance", { passed: errors === 0, errors,
  note: "No signing, submission or confirmed fill claimed" });
if (errors) process.exitCode = 1;
