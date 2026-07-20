import type {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import type { QuoteAsset, RawAmount } from "../core/amounts.ts";
import type { TokenRow } from "../db/schema.ts";
import { UnknownLaunchpadError } from "../core/errors.ts";

export type PrepareDeploymentArgs = {
  name: string;
  symbol: string;
  uri: string;
  user: PublicKey;
  creator?: PublicKey;
  mint?: Keypair;
  quoteAsset?: QuoteAsset;
  mayhemMode?: boolean;
  cashback?: boolean;
};

export type PreparedTokenDeployment = {
  launchpad: string;
  mint: Keypair;
  user: PublicKey;
  creator: PublicKey;
  quoteAsset: QuoteAsset;
  token: Partial<TokenRow> & { mint: string };
  instructions: TransactionInstruction[];
  signers: Keypair[];
  metadata?: Record<string, unknown>;
};

/** Opaque launchpad-owned state used to quote sequential buys before create lands. */
export type PendingMarketState = unknown;

export type PreparedPendingBuy = {
  launchpad: string;
  mint: PublicKey;
  quoteAsset: QuoteAsset;
  buyer: PublicKey;
  instructions: TransactionInstruction[];
  expectedOutputRaw: bigint;
  minimumOutputRaw: bigint;
  nextState: PendingMarketState;
  metadata?: Record<string, unknown>;
};

/**
 * Creates tokens and optionally prepares buys against a token whose mint is
 * known but whose create transaction has not landed yet. It is deliberately
 * separate from TradeVenuePlugin: creating a market is not routing an
 * existing market.
 */
export interface TokenLaunchpadPlugin {
  readonly id: string;
  prepareDeployment(
    connection: Connection,
    args: PrepareDeploymentArgs,
  ): Promise<PreparedTokenDeployment>;
  initialPendingMarketState?(
    connection: Connection,
    deployment: PreparedTokenDeployment,
  ): Promise<PendingMarketState>;
  buildPendingBuy?(
    connection: Connection,
    deployment: PreparedTokenDeployment,
    buyer: PublicKey,
    amount: RawAmount,
    state: PendingMarketState,
    options?: { slippageBps?: number },
  ): Promise<PreparedPendingBuy>;
}

export class LaunchpadRegistry {
  private readonly plugins = new Map<string, TokenLaunchpadPlugin>();

  register(plugin: TokenLaunchpadPlugin): this {
    this.plugins.set(plugin.id, plugin);
    return this;
  }

  list(): readonly string[] {
    return [...this.plugins.keys()];
  }

  resolve(id: string): TokenLaunchpadPlugin {
    const plugin = this.plugins.get(id);
    if (!plugin) throw new UnknownLaunchpadError(id);
    return plugin;
  }
}
