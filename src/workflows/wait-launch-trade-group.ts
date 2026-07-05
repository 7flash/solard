import type { HumanAmount } from "../core/amounts.js";
import type { GroupRef } from "../core/refs.js";
import type { LaunchFilter } from "../launches/launch-source.js";
import type { BatchSendReceipt, SenderId } from "../tx/types.js";
import type { WorkflowHost, WorkflowPlugin } from "./workflow-plugin.js";

export type WaitLaunchTradeGroupArgs = {
  launch: {
    source: string;
    match: LaunchFilter;
    alias?: string;
    timeoutMs?: number;
  };
  group: GroupRef;
  buy: {
    amount: HumanAmount;
    slippageBps?: number;
  };
  priorityFee?: { cuLimit?: number; microLamports?: number };
  via?: SenderId;
};

export type WaitLaunchTradeGroupResult = {
  launch: {
    source: string;
    signature: string;
    slot: number | null;
    mint: string;
    name: string | null;
    symbol: string | null;
  };
  token: {
    mint: string;
    name: string | null;
    symbol: string | null;
    venueHint: string;
  };
  buy: BatchSendReceipt;
};

/**
 * Waits for one launch from a pluggable discovery source, persists/inspects it,
 * then routes buys for a stored wallet group through the available trade venues.
 */
export class WaitLaunchTradeGroupWorkflow implements WorkflowPlugin<
  WaitLaunchTradeGroupArgs,
  WaitLaunchTradeGroupResult
> {
  readonly id = "wait-launch-trade-group";

  async execute(
    host: WorkflowHost,
    args: WaitLaunchTradeGroupArgs,
  ): Promise<WaitLaunchTradeGroupResult> {
    const launch = await host.waitForLaunch(args.launch.source, {
      filter: args.launch.match,
      timeoutMs: args.launch.timeoutMs,
      commitment: "confirmed",
    });
    const token = await host.persistLaunch(launch, args.launch.alias);
    const wallets = host.groupWallets(args.group);
    if (args.via === "jito" && wallets.length > 5) {
      throw new Error(
        `Jito bundle execution supports at most 5 wallet buys per submission; group ${args.group} has ${wallets.length}`,
      );
    }
    const batch = host.composeMany(wallets);
    if (args.priorityFee) batch.priorityFee(args.priorityFee);
    batch.buy(token, args.buy.amount, {
      slippageBps: args.buy.slippageBps ?? 1500,
    });
    const receipt = await batch.send({
      via: args.via ?? "rpc",
      kind: `workflow:${this.id}`,
    });
    return {
      launch: {
        source: launch.source,
        signature: launch.signature,
        slot: launch.slot,
        mint: launch.mint.toBase58(),
        name: launch.name,
        symbol: launch.symbol,
      },
      token: {
        mint: token.mint,
        name: token.name,
        symbol: token.symbol,
        venueHint: token.venueHint,
      },
      buy: receipt,
    };
  }
}
