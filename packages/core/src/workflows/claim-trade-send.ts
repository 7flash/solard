import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { rawAmount, sameAsset } from "../core/amounts.ts";
import { QuoteAssetMismatchError } from "../core/errors.ts";
import type { TokenRef, WalletRef } from "../core/refs.ts";
import { transferTokenIxs } from "../tx/spl.ts";
import type { SendReceipt, SenderId } from "../tx/types.ts";
import type { WorkflowHost, WorkflowPlugin } from "./workflow-plugin.ts";

export type ClaimTradeSendArgs = {
  wallet: WalletRef;
  claim: { token: TokenRef };
  trade: {
    buyToken: TokenRef;
    reserveRaw?: bigint | string | number;
    slippageBps?: number;
  };
  delivery: { recipient: string | PublicKey; amount?: "guaranteed-minimum" };
  priorityFee?: { cuLimit?: number; microLamports?: number };
  via?: SenderId;
};

/**
 * A venue-agnostic strategy: claim from any ClaimSourcePlugin, buy through any
 * TradeVenuePlugin quoted in the same claimed asset, then deliver the guaranteed output.
 */
export class ClaimTradeSendWorkflow implements WorkflowPlugin<
  ClaimTradeSendArgs,
  SendReceipt
> {
  readonly id = "claim-trade-send";

  async execute(
    host: WorkflowHost,
    args: ClaimTradeSendArgs,
  ): Promise<SendReceipt> {
    const signer = host.signer(args.wallet);
    const user = signer.publicKey;
    const claimToken = host.resolveToken(args.claim.token);
    const claim = await host.resolveClaim(claimToken, user);
    const reserve =
      args.trade.reserveRaw == null ? 0n : BigInt(args.trade.reserveRaw);
    const available = claim.spendableByUserRaw - reserve;
    if (available <= 0n) {
      throw new Error(
        `Claim source ${claim.source} has no spendable output after reserve; estimated=${claim.estimatedClaimRaw} spendable=${claim.spendableByUserRaw} reserve=${reserve}`,
      );
    }

    const buyToken = host.resolveToken(args.trade.buyToken);
    const { plugin: venue, market } = await host.route(buyToken, user);
    if (!sameAsset(claim.quoteAsset, market.quoteAsset)) {
      throw new QuoteAssetMismatchError(
        claim.quoteAsset.mint.toBase58(),
        market.quoteAsset.mint.toBase58(),
      );
    }
    const quote = await venue.quoteBuy(
      { connection: host.connection(), token: buyToken, user },
      market,
      rawAmount(available, claim.quoteAsset),
      args.trade.slippageBps ?? 1500,
    );
    const buy = await venue.buildBuy(
      { connection: host.connection(), token: buyToken, user },
      market,
      quote,
    );
    const recipient =
      typeof args.delivery.recipient === "string"
        ? new PublicKey(args.delivery.recipient)
        : args.delivery.recipient;
    const transfer = transferTokenIxs({
      payer: user,
      owner: user,
      recipient,
      mint: market.mint,
      amountRaw: quote.minimumOutputRaw,
      decimals: buyToken.decimals ?? 6,
      tokenProgram: market.baseTokenProgram,
    });

    const tx = host.transaction(args.wallet);
    if (args.priorityFee) tx.priorityFee(args.priorityFee);
    tx.addMany(claim.instructions, {
      kind: "claim",
      mint: new PublicKey(claimToken.mint),
      meta: {
        source: claim.source,
        quoteMint: claim.quoteAsset.mint.toBase58(),
        estimatedClaimRaw: claim.estimatedClaimRaw.toString(),
        spendableByUserRaw: claim.spendableByUserRaw.toString(),
        ...claim.meta,
      },
    });
    tx.addMany(buy.instructions, {
      kind: "buy",
      mint: market.mint,
      meta: {
        venue: market.venue,
        workflow: this.id,
        inputRaw: available.toString(),
        minOutputRaw: quote.minimumOutputRaw.toString(),
      },
    });
    tx.addMany(transfer.instructions, {
      kind: "transfer-token",
      mint: market.mint,
      recipient,
      meta: {
        workflow: this.id,
        raw: quote.minimumOutputRaw.toString(),
        amountPolicy: "guaranteed-minimum",
      },
    });
    if (claim.quoteAsset.kind === "native-sol")
      tx.track({ address: user, kind: "sol" });
    else
      tx.track({
        address: getAssociatedTokenAddressSync(
          claim.quoteAsset.mint,
          user,
          false,
          claim.quoteAsset.tokenProgram,
        ),
        kind: "token",
        mint: claim.quoteAsset.mint,
      });
    tx.track({
      address: transfer.destination,
      kind: "token",
      mint: market.mint,
    });
    return await tx.send({
      via: args.via ?? "rpc",
      kind: `workflow:${this.id}`,
    });
  }
}
