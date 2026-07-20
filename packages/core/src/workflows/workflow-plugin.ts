import type { Connection, Keypair } from "@solana/web3.js";
import type { GroupRef, TokenRef, WalletRef } from "../core/refs.ts";
import type {
  DiscoveredLaunch,
  WaitForLaunchArgs,
} from "../launches/launch-source.ts";
import type { TokenRow } from "../db/schema.ts";
import type { TransactionBuilder } from "../tx/transaction-builder.ts";
import type { BatchComposer } from "../tx/composer.ts";
import type { TradeVenuePlugin, VenueMarket } from "../venues/venue-plugin.ts";
import type { ClaimPlan } from "../claims/claim-source.ts";

export interface WorkflowHost {
  connection(): Connection;
  signer(ref: WalletRef): Keypair;
  resolveToken(ref: TokenRef): TokenRow;
  transaction(wallet: WalletRef): TransactionBuilder;
  route(
    token: TokenRow,
    user: Keypair["publicKey"],
  ): Promise<{ plugin: TradeVenuePlugin; market: VenueMarket }>;
  resolveClaim(token: TokenRow, user: Keypair["publicKey"]): Promise<ClaimPlan>;
  waitForLaunch(
    sourceId: string,
    args: WaitForLaunchArgs,
  ): Promise<DiscoveredLaunch>;
  persistLaunch(launch: DiscoveredLaunch, alias?: string): Promise<TokenRow>;
  groupWallets(group: GroupRef): WalletRef[];
  composeMany(wallets: WalletRef[]): BatchComposer;
}

/** Workflows compose capabilities. They are opt-in plugins, never methods hard-coded onto Solard. */
export interface WorkflowPlugin<Args = unknown, Result = unknown> {
  readonly id: string;
  execute(host: WorkflowHost, args: Args): Promise<Result>;
}

export class WorkflowRegistry {
  private readonly plugins = new Map<string, WorkflowPlugin<any, any>>();
  constructor(private readonly host: WorkflowHost) {}

  register<Args, Result>(plugin: WorkflowPlugin<Args, Result>): this {
    this.plugins.set(plugin.id, plugin as WorkflowPlugin<any, any>);
    return this;
  }
  list(): readonly string[] {
    return [...this.plugins.keys()];
  }
  resolve<Args, Result>(id: string): WorkflowPlugin<Args, Result> {
    const plugin = this.plugins.get(id);
    if (!plugin)
      throw new Error(
        `Unknown workflow: ${id}. Registered: ${this.list().join(", ") || "none"}`,
      );
    return plugin as WorkflowPlugin<Args, Result>;
  }
  async run<Args, Result>(id: string, args: Args): Promise<Result> {
    return await this.resolve<Args, Result>(id).execute(this.host, args);
  }
}
