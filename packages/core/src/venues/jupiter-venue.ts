import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { readMint } from "../chain/state.ts";
import { SOL_ASSET, type RawAmount } from "../core/amounts.ts";
import type { TradeVenuePlugin, VenueContext, VenueMarket, QuoteResult, BuiltInstructions } from "./venue-plugin.ts";

type WireInstruction = { programId: string; accounts: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>; data: string };
type WireQuote = { inputMint: string; outputMint: string; inAmount: string; outAmount: string; otherAmountThreshold: string; swapMode: string; slippageBps: number; routePlan: unknown[] };
const uint = (value: unknown) => typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : null;
function noRoute(message: string): Error { return Object.assign(new Error(message), { code: "NO_ROUTE" }); }

/** Instruction-only fallback. Never signs or uses Jupiter's execution endpoint. */
export class JupiterVenue implements TradeVenuePlugin {
  readonly id = "jupiter";
  private static gate = Promise.resolve();
  private static lastRequest = 0;
  constructor(private readonly request: typeof fetch = fetch) {}
  private async api(path: string, init?: RequestInit): Promise<any> {
    const root = process.env.JUPITER_SWAP_API_URL ?? "https://api.jup.ag/swap/v1";
    let response: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.request === fetch) {
        const slot = JupiterVenue.gate.then(async () => {
          const delay = Math.max(0, (process.env.JUPITER_API_KEY ? 1_000 : 2_100) - (Date.now() - JupiterVenue.lastRequest));
          if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
          JupiterVenue.lastRequest = Date.now();
        });
        JupiterVenue.gate = slot.catch(() => {}); await slot;
      }
      response = await this.request(`${root.replace(/\/$/, "")}/${path}`, {
      ...init, signal: AbortSignal.timeout(20_000),
      headers: { "Content-Type": "application/json", ...(process.env.JUPITER_API_KEY ? { "x-api-key": process.env.JUPITER_API_KEY } : {}), ...init?.headers },
    });
      if (![429, 502, 503, 504].includes(response.status) || attempt === 2) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(5_000, Math.max(1_000, Number(response!.headers.get("retry-after") ?? 0) * 1_000))));
    }
    if (!response) throw noRoute("Jupiter route request failed");
    if (!response.ok) throw noRoute(`Jupiter instruction route unavailable (HTTP ${response.status})`);
    const data = await response.json();
    if (data.error) throw noRoute(String(data.error));
    return data;
  }
  async inspectToken(connection: VenueContext["connection"], mint: PublicKey) {
    const info = await readMint(connection, mint);
    return { venueHint: "jupiter" as const, decimals: info.decimals, baseTokenProgram: info.tokenProgram.toBase58() };
  }
  async resolveMarket(ctx: VenueContext): Promise<VenueMarket> {
    const info = await readMint(ctx.connection, new PublicKey(ctx.token.mint));
    return { venue: this.id, mint: new PublicKey(ctx.token.mint), baseTokenProgram: info.tokenProgram, quoteAsset: SOL_ASSET, creator: null, metadata: {} };
  }
  private async quote(market: VenueMarket, inputRaw: bigint, buy: boolean, slippageBps: number): Promise<QuoteResult> {
    if (inputRaw <= 0n || !Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10_000) throw noRoute("Invalid Jupiter amount/slippage");
    const inputMint = (buy ? SOL_ASSET.mint : market.mint).toBase58();
    const outputMint = (buy ? market.mint : SOL_ASSET.mint).toBase58();
    const raw: WireQuote = await this.api(`quote?${new URLSearchParams({ inputMint, outputMint, amount: inputRaw.toString(), swapMode: "ExactIn", slippageBps: String(slippageBps), ...(process.env.JUPITER_DEXES ? { dexes: process.env.JUPITER_DEXES } : {}) })}`);
    const output = uint(raw.outAmount); const minimum = uint(raw.otherAmountThreshold);
    if (raw.inputMint !== inputMint || raw.outputMint !== outputMint || uint(raw.inAmount) !== inputRaw || raw.swapMode !== "ExactIn" || raw.slippageBps !== slippageBps || !Array.isArray(raw.routePlan) || !raw.routePlan.length || output == null || minimum == null || minimum <= 0n || minimum > output || minimum < output * BigInt(10_000 - slippageBps) / 10_000n) throw noRoute("Invalid or unprotected Jupiter quote");
    return { venue: this.id, quoteAsset: SOL_ASSET, inputRaw, expectedOutputRaw: output, minimumOutputRaw: minimum, meta: { jupiterQuote: raw, slippageBps } };
  }
  quoteBuy(_ctx: VenueContext, market: VenueMarket, amount: RawAmount, slippageBps: number) {
    if (amount.asset.kind !== "native-sol") throw noRoute("Jupiter buy requires SOL input");
    return this.quote(market, amount.raw, true, slippageBps);
  }
  quoteSell(_ctx: VenueContext, market: VenueMarket, amount: bigint, slippageBps: number) { return this.quote(market, amount, false, slippageBps); }
  async price(): Promise<never> { throw noRoute("Jupiter routing does not supply a verified live pool price feed"); }
  private async build(ctx: VenueContext, quote: QuoteResult): Promise<BuiltInstructions> {
    const raw = await this.api("swap-instructions", { method: "POST", body: JSON.stringify({ quoteResponse: quote.meta?.jupiterQuote, userPublicKey: ctx.user.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: false, useSharedAccounts: false }) });
    if (!raw.swapInstruction) throw noRoute("Jupiter returned no swap instruction");
    const instructions = [...(raw.otherInstructions ?? []), ...(raw.setupInstructions ?? []), raw.swapInstruction, ...(raw.cleanupInstruction ? [raw.cleanupInstruction] : [])].map((wire: WireInstruction) => {
      if (wire.accounts.some((account) => account.isSigner && account.pubkey !== ctx.user.toBase58())) throw noRoute("Jupiter route requires an unknown signer");
      return new TransactionInstruction({ programId: new PublicKey(wire.programId), keys: wire.accounts.map((account) => ({ pubkey: new PublicKey(account.pubkey), isSigner: account.isSigner, isWritable: account.isWritable })), data: Buffer.from(wire.data, "base64") });
    });
    return { venue: this.id, quoteAsset: SOL_ASSET, instructions, minOutputRaw: quote.minimumOutputRaw, expectedOutputRaw: quote.expectedOutputRaw, meta: { lookupTableAddresses: raw.addressLookupTableAddresses ?? [], routePlan: (quote.meta?.jupiterQuote as WireQuote).routePlan, slippageBps: quote.meta?.slippageBps } };
  }
  buildBuy(ctx: VenueContext, _market: VenueMarket, quote: QuoteResult) { return this.build(ctx, quote); }
  buildSell(ctx: VenueContext, _market: VenueMarket, quote: QuoteResult) { return this.build(ctx, quote); }
}
