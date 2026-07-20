import type {
  Connection,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import type { QuoteAsset } from "../core/amounts.ts";
import type { TokenRow } from "../db/schema.ts";

export type ClaimContext = {
  connection: Connection;
  token: TokenRow;
  user: PublicKey;
};
export type ClaimPlan = {
  source: string;
  quoteAsset: QuoteAsset;
  instructions: TransactionInstruction[];
  estimatedClaimRaw: bigint;
  /** Amount of the estimate that the signing wallet may spend immediately in this transaction. */
  spendableByUserRaw: bigint;
  meta?: Record<string, unknown>;
};

/**
 * A producer of value: creator fees, cashback, staking rewards or any later yield adapter.
 * It is separate from a trade venue because rewards may be spent on any resolved venue.
 */
export interface ClaimSourcePlugin {
  readonly id: string;
  resolveClaim(ctx: ClaimContext): Promise<ClaimPlan | null>;
}

export class ClaimSourceRegistry {
  private readonly plugins: ClaimSourcePlugin[] = [];

  register(plugin: ClaimSourcePlugin): this {
    const existing = this.plugins.findIndex((item) => item.id === plugin.id);
    if (existing >= 0) this.plugins.splice(existing, 1, plugin);
    else this.plugins.push(plugin);
    return this;
  }

  list(): readonly ClaimSourcePlugin[] {
    return this.plugins;
  }

  async resolve(
    connection: Connection,
    token: TokenRow,
    user: PublicKey,
  ): Promise<{ plugin: ClaimSourcePlugin; plan: ClaimPlan }> {
    for (const plugin of this.plugins) {
      const plan = await plugin.resolveClaim({ connection, token, user });
      if (plan) return { plugin, plan };
    }
    throw new Error(
      `No registered claim source can claim value for token ${token.mint}`,
    );
  }
}
