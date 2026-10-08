import {
  getAssociatedTokenAddressSync,
  getAccount,
  getTransferFeeAmount,
} from "@solana/spl-token";
import { PublicKey, type Connection } from "@solana/web3.js";
import type { HumanAmount } from "../core/amounts.ts";
import { rawAmount, sameAsset, toRawAmount } from "../core/amounts.ts";
import { QuoteAssetMismatchError } from "../core/errors.ts";
import { decimalsOr } from "../core/decimals.ts";
import { readMint, listOwnedTokenAccounts } from "../chain/state.ts";
import { assertTradeMinimum } from "./trade-minimum.ts";
import { assertTradePrice, type SolPrice } from "./price-guard.ts";
import { TradePreSubmissionError } from "./trade-errors.ts";
import type { TokenRef, WalletRef } from "../core/refs.ts";
import type { TokenRow } from "../db/schema.ts";
import type { ClaimPlan } from "../claims/claim-source.ts";
import type {
  TradeVenuePlugin,
  VenueMarket,
  LivePoolReserves,
} from "../venues/venue-plugin.ts";
import {
  closeTokenAccountIx,
  transferSolIx,
  transferTokenIxs,
  unwrapWsolIxs,
} from "./spl.ts";
import {
  TransactionBuilder,
  type TransactionHost,
} from "./transaction-builder.ts";
import type {
  BatchSendReceipt,
  SendReceipt,
  SenderId,
  SendOptions,
} from "./types.ts";

export interface ComposerHost extends TransactionHost {
  connection(): Connection;
  resolveTokenForExecution(ref: TokenRef): Promise<TokenRow>;
  route(
    token: TokenRow,
    user: PublicKey,
    options?: { reserves?: LivePoolReserves },
  ): Promise<{ plugin: TradeVenuePlugin; market: VenueMarket }>;
  resolveClaim(token: TokenRow, user: PublicKey): Promise<ClaimPlan>;
  tokenBalance(
    owner: PublicKey,
    token: TokenRow,
    tokenProgram: PublicKey,
  ): Promise<bigint>;
  sendBatchPlans(
    plans: import("./types.ts").PlannedTransaction[],
    via: SenderId,
    kind?: string,
    options?: SendOptions,
  ): Promise<BatchSendReceipt>;
}
type Context = {
  lastBuy?: { token: TokenRow; market: VenueMarket; minimumOutputRaw: bigint };
};
type Operation = (ctx: Context, composer: TransactionComposer) => Promise<void>;

function legSlippageBps(totalBps: number): number {
  const total = Math.max(0, Math.min(9_999, Math.trunc(totalBps)));
  // Two legs each protect (1-leg)^2 >= (1-total). Rounding down keeps the
  // combined minimum at least as strict as the caller's end-to-end limit.
  return Math.floor((1 - Math.sqrt(1 - total / 10_000)) * 10_000);
}

/** Generic transaction sugar for one-off actions. Trading strategies belong in scripts that import slrd. */
export class TransactionComposer extends TransactionBuilder {
  private readonly operations: Operation[] = [];
  private materialized = false;
  constructor(
    protected readonly composerHost: ComposerHost,
    payer: WalletRef,
  ) {
    super(composerHost, payer);
  }
  private addOperation(operation: Operation): this {
    if (this.materialized) throw new Error("Cannot change a built transaction");
    this.operations.push(operation);
    return this;
  }
  private async materialize(): Promise<void> {
    if (this.materialized) return;
    const context: Context = {};
    for (const operation of this.operations) await operation(context, this);
    this.materialized = true;
  }
  async materializedDraft() {
    await this.materialize();
    return this.snapshot();
  }
  override async build() {
    try {
      await this.materialize();
      return await super.build();
    } catch (error) {
      if (error instanceof TradePreSubmissionError) throw error;
      throw new TradePreSubmissionError(error);
    }
  }

  claimFees(ref: TokenRef): this {
    return this.addOperation(async (_ctx, tx) => {
      const token = await this.composerHost.resolveTokenForExecution(ref);
      const plan = await this.composerHost.resolveClaim(token, tx.payer());
      tx.addMany(plan.instructions, {
        kind: "claim",
        mint: new PublicKey(token.mint),
        meta: {
          source: plan.source,
          quoteMint: plan.quoteAsset.mint.toBase58(),
          estimatedClaimRaw: plan.estimatedClaimRaw.toString(),
          spendableByUserRaw: plan.spendableByUserRaw.toString(),
          ...plan.meta,
        },
      });
      if (plan.quoteAsset.kind === "native-sol")
        tx.track({ address: tx.payer(), kind: "sol" });
      else
        tx.track({
          address: getAssociatedTokenAddressSync(
            plan.quoteAsset.mint,
            tx.payer(),
            false,
            plan.quoteAsset.tokenProgram,
          ),
          kind: "token",
          mint: plan.quoteAsset.mint,
        });
    });
  }

  buy(
    ref: TokenRef,
    amount: HumanAmount,
    options: {
      slippageBps?: number;
      minOutputRaw?: bigint | string;
      maxPriceSol?: SolPrice;
      reserves?: LivePoolReserves;
    } = {},
  ): this {
    return this.addOperation(async (ctx, tx) => {
      const token = await this.composerHost.resolveTokenForExecution(ref);
      const { plugin, market } = await this.composerHost.route(
        token,
        tx.payer(),
        { reserves: options.reserves },
      );
      const input = toRawAmount(amount);
      if (options.maxPriceSol != null && input.asset.kind !== "native-sol")
        throw new Error("maxPriceSol requires SOL-funded input");
      const totalSlippageBps = options.slippageBps ?? 1500;
      let quoteInput = input;
      let fundingRoute: Record<string, unknown> | null = null;

      if (!sameAsset(input.asset, market.quoteAsset)) {
        if (
          input.asset.kind !== "native-sol" ||
          market.quoteAsset.kind !== "spl-token"
        )
          throw new QuoteAssetMismatchError(
            input.asset.mint.toBase58(),
            market.quoteAsset.mint.toBase58(),
          );

        const fundingToken = await this.composerHost.resolveTokenForExecution(
          market.quoteAsset.mint,
        );
        const funding = await this.composerHost.route(fundingToken, tx.payer());
        if (!sameAsset(funding.market.quoteAsset, input.asset))
          throw new QuoteAssetMismatchError(
            input.asset.mint.toBase58(),
            market.quoteAsset.mint.toBase58(),
          );

        const perLegBps = legSlippageBps(totalSlippageBps);
        const fundingQuote = await funding.plugin.quoteBuy(
          {
            connection: this.composerHost.connection(),
            token: fundingToken,
            user: tx.payer(),
          },
          funding.market,
          input,
          perLegBps,
        );
        const fundingBuilt = await funding.plugin.buildBuy(
          {
            connection: this.composerHost.connection(),
            token: fundingToken,
            user: tx.payer(),
          },
          funding.market,
          fundingQuote,
        );
        // Intentionally omit a trade action for the funding leg. The execution
        // remains one target-token BUY for accounting, while the transaction is
        // atomic. The second leg consumes only the guaranteed first-leg output,
        // so pre-existing quote-token holdings cannot be spent.
        tx.addMany(fundingBuilt.instructions);
        tx.track({
          address: getAssociatedTokenAddressSync(
            funding.market.mint,
            tx.payer(),
            false,
            funding.market.baseTokenProgram,
          ),
          kind: "token",
          mint: funding.market.mint,
        });
        quoteInput = rawAmount(
          fundingBuilt.minOutputRaw ?? fundingQuote.minimumOutputRaw,
          market.quoteAsset,
        );
        fundingRoute = {
          venue: funding.market.venue,
          quoteMint: market.quoteAsset.mint.toBase58(),
          inputRaw: input.raw.toString(),
          guaranteedIntermediateRaw: quoteInput.raw.toString(),
          slippageBps: perLegBps,
        };
      }

      const targetSlippageBps = fundingRoute
        ? legSlippageBps(totalSlippageBps)
        : totalSlippageBps;
      const quote = await plugin.quoteBuy(
        {
          connection: this.composerHost.connection(),
          token,
          user: tx.payer(),
          reserves: options.reserves,
        },
        market,
        quoteInput,
        targetSlippageBps,
      );
      const built = await plugin.buildBuy(
        {
          connection: this.composerHost.connection(),
          token,
          user: tx.payer(),
          reserves: options.reserves,
        },
        market,
        quote,
      );
      assertTradeMinimum(
        built.minOutputRaw ?? quote.minimumOutputRaw,
        options.minOutputRaw,
      );
      assertTradePrice(
        "buy",
        input.raw,
        built.minOutputRaw ?? quote.minimumOutputRaw,
        token.decimals,
        options.maxPriceSol,
      );
      tx.addMany(built.instructions, {
        kind: "buy",
        mint: market.mint,
        meta: {
          venue: market.venue,
          inputRaw: input.raw.toString(),
          quoteInputRaw: quoteInput.raw.toString(),
          minOutputRaw: (
            built.minOutputRaw ?? quote.minimumOutputRaw
          ).toString(),
          totalSlippageBps,
          ...(fundingRoute ? { fundingRoute } : {}),
          ...(quote.meta ?? {}),
          ...(built.meta ?? {}),
          expectedOutputRaw: (
            built.expectedOutputRaw ?? quote.expectedOutputRaw
          ).toString(),
        },
      });
      ctx.lastBuy = {
        token,
        market,
        minimumOutputRaw: built.minOutputRaw ?? quote.minimumOutputRaw,
      };
      tx.track({
        address: getAssociatedTokenAddressSync(
          market.mint,
          tx.payer(),
          false,
          market.baseTokenProgram,
        ),
        kind: "token",
        mint: market.mint,
      });
      if (input.asset.kind === "native-sol")
        tx.track({ address: tx.payer(), kind: "sol" });
    });
  }

  sell(
    ref: TokenRef,
    options: {
      bps?: number;
      amountRaw?: bigint | string;
      slippageBps?: number;
      minOutputLamports?: bigint | string;
      minPriceSol?: SolPrice;
      reserves?: LivePoolReserves;
      closeTokenAccount?: boolean;
    } = {},
  ): this {
    return this.addOperation(async (_ctx, tx) => {
      const token = await this.composerHost.resolveTokenForExecution(ref);
      const { plugin, market } = await this.composerHost.route(
        token,
        tx.payer(),
        { reserves: options.reserves },
      );
      const balance = await this.composerHost.tokenBalance(
        tx.payer(),
        token,
        market.baseTokenProgram,
      );
      if (options.amountRaw !== undefined && options.bps !== undefined)
        throw new Error("sell amountRaw and bps are mutually exclusive");
      let input: bigint;
      if (options.amountRaw !== undefined) {
        if (
          typeof options.amountRaw !== "bigint" &&
          (typeof options.amountRaw !== "string" ||
            !/^\d+$/.test(options.amountRaw))
        )
          throw new Error("sell amountRaw must be a positive raw integer");
        input = BigInt(options.amountRaw);
        if (input <= 0n)
          throw new Error("sell amountRaw must be a positive raw integer");
        if (input > balance)
          throw Object.assign(
            new Error(
              `Requested sell amount ${input} exceeds token balance ${balance}`,
            ),
            { code: "INSUFFICIENT_TOKEN_BALANCE" },
          );
      } else {
        const bps = options.bps ?? 10_000;
        if (!Number.isInteger(bps) || bps < 1 || bps > 10_000)
          throw new Error("sell bps must be an integer between 1 and 10000");
        input = (balance * BigInt(bps)) / 10_000n;
      }
      if (input <= 0n) throw new Error("No tokens available to sell");
      if (options.closeTokenAccount && input !== balance)
        throw new Error(
          "closeTokenAccount requires selling the entire token-account balance",
        );
      const totalSlippageBps = options.slippageBps ?? 1500;
      const needsExitRouting = market.quoteAsset.kind === "spl-token";
      const targetSlippageBps = needsExitRouting
        ? legSlippageBps(totalSlippageBps)
        : totalSlippageBps;
      const quote = await plugin.quoteSell(
        {
          connection: this.composerHost.connection(),
          token,
          user: tx.payer(),
          reserves: options.reserves,
        },
        market,
        input,
        targetSlippageBps,
      );
      const built = await plugin.buildSell(
        {
          connection: this.composerHost.connection(),
          token,
          user: tx.payer(),
          reserves: options.reserves,
        },
        market,
        quote,
      );

      let exitRoute: Record<string, unknown> | null = null;
      if (needsExitRouting) {
        const quoteToken = await this.composerHost.resolveTokenForExecution(
          market.quoteAsset.mint,
        );
        const exit = await this.composerHost.route(quoteToken, tx.payer());
        if (exit.market.quoteAsset.kind !== "native-sol")
          throw new QuoteAssetMismatchError(
            market.quoteAsset.mint.toBase58(),
            exit.market.quoteAsset.mint.toBase58(),
          );
        const exitQuote = await exit.plugin.quoteSell(
          {
            connection: this.composerHost.connection(),
            token: quoteToken,
            user: tx.payer(),
          },
          exit.market,
          built.minOutputRaw ?? quote.minimumOutputRaw,
          legSlippageBps(totalSlippageBps),
        );
        const exitBuilt = await exit.plugin.buildSell(
          {
            connection: this.composerHost.connection(),
            token: quoteToken,
            user: tx.payer(),
          },
          exit.market,
          exitQuote,
        );
        assertTradeMinimum(
          exitBuilt.minOutputRaw ?? exitQuote.minimumOutputRaw,
          options.minOutputLamports,
        );
        assertTradePrice(
          "sell",
          input,
          exitBuilt.minOutputRaw ?? exitQuote.minimumOutputRaw,
          token.decimals,
          options.minPriceSol,
        );
        tx.addMany(built.instructions);
        tx.addMany(exitBuilt.instructions, {
          kind: "sell",
          mint: market.mint,
          meta: {
            venue: market.venue,
            inputRaw: input.toString(),
            guaranteedIntermediateRaw: (
              built.minOutputRaw ?? quote.minimumOutputRaw
            ).toString(),
            minSolOutputRaw: (
              exitBuilt.minOutputRaw ?? exitQuote.minimumOutputRaw
            ).toString(),
            minOutputRaw: (
              exitBuilt.minOutputRaw ?? exitQuote.minimumOutputRaw
            ).toString(),
            expectedOutputRaw: (
              exitBuilt.expectedOutputRaw ?? exitQuote.expectedOutputRaw
            ).toString(),
            totalSlippageBps,
            exitRoute: {
              venue: exit.market.venue,
              quoteMint: market.quoteAsset.mint.toBase58(),
              slippageBps: legSlippageBps(totalSlippageBps),
            },
          },
        });
        exitRoute = { venue: exit.market.venue };
        tx.track({
          address: getAssociatedTokenAddressSync(
            exit.market.mint,
            tx.payer(),
            false,
            exit.market.baseTokenProgram,
          ),
          kind: "token",
          mint: exit.market.mint,
        });
        tx.track({ address: tx.payer(), kind: "sol" });
      } else {
        assertTradeMinimum(
          built.minOutputRaw ?? quote.minimumOutputRaw,
          options.minOutputLamports,
        );
        assertTradePrice(
          "sell",
          input,
          built.minOutputRaw ?? quote.minimumOutputRaw,
          token.decimals,
          options.minPriceSol,
        );
        tx.addMany(built.instructions, {
          kind: "sell",
          mint: market.mint,
          meta: {
            venue: market.venue,
            inputRaw: input.toString(),
            minOutputRaw: (
              built.minOutputRaw ?? quote.minimumOutputRaw
            ).toString(),
            totalSlippageBps,
            ...(built.meta ?? {}),
            expectedOutputRaw: (
              built.expectedOutputRaw ?? quote.expectedOutputRaw
            ).toString(),
          },
        });
      }
      void exitRoute;
      if (options.closeTokenAccount) {
        const address = getAssociatedTokenAddressSync(
          market.mint,
          tx.payer(),
          false,
          market.baseTokenProgram,
        );
        const account = await getAccount(
          this.composerHost.connection(),
          address,
          "confirmed",
          market.baseTokenProgram,
        );
        if (
          !(account.closeAuthority ?? account.owner).equals(tx.payer()) ||
          (getTransferFeeAmount(account)?.withheldAmount ?? 0n) > 0n
        )
          throw new Error(
            "Token account cannot be closed by this wallet or contains withheld fees",
          );
        tx.add(
          closeTokenAccountIx({
            account: address,
            owner: tx.payer(),
            tokenProgram: market.baseTokenProgram,
          }),
          { kind: "close-token-account", mint: market.mint },
        );
      }
      tx.track({
        address: getAssociatedTokenAddressSync(
          market.mint,
          tx.payer(),
          false,
          market.baseTokenProgram,
        ),
        kind: "token",
        mint: market.mint,
      });
    });
  }

  closeTokenAccountAddress(
    account: string | PublicKey,
    tokenProgram: string | PublicKey,
    options: { destination?: string | PublicKey } = {},
  ): this {
    return this.addOperation(async (_ctx, tx) => {
      const accountKey =
        typeof account === "string" ? new PublicKey(account) : account;
      const programKey =
        typeof tokenProgram === "string"
          ? new PublicKey(tokenProgram)
          : tokenProgram;
      const destination =
        typeof options.destination === "string"
          ? new PublicKey(options.destination)
          : (options.destination ?? tx.payer());
      tx.add(
        closeTokenAccountIx({
          account: accountKey,
          owner: tx.payer(),
          destination,
          tokenProgram: programKey,
        }),
        {
          kind: "close-token-account",
          recipient: destination,
          meta: {
            tokenAccount: accountKey.toBase58(),
            tokenProgram: programKey.toBase58(),
          },
        },
      );
      tx.track({ address: tx.payer(), kind: "sol" });
      tx.track({ address: accountKey, kind: "token" });
    });
  }

  unwrapWsol(
    options: { destination?: string | PublicKey; skipMissing?: boolean } = {},
  ): this {
    return this.addOperation(async (_ctx, tx) => {
      const destination =
        typeof options.destination === "string"
          ? new PublicKey(options.destination)
          : options.destination;
      const unwrap = unwrapWsolIxs({ owner: tx.payer(), destination });

      if (options.skipMissing) {
        const account = await this.composerHost
          .connection()
          .getAccountInfo(unwrap.account, "confirmed");
        if (!account) return;
      }

      tx.addMany(unwrap.instructions, {
        kind: "unwrap-wsol",
        mint: unwrap.mint,
        recipient: unwrap.destination,
        meta: {
          sourceAccount: unwrap.account.toBase58(),
          destination: unwrap.destination.toBase58(),
          tokenProgram: unwrap.tokenProgram.toBase58(),
        },
      });
      tx.track({ address: tx.payer(), kind: "sol" });
      tx.track({ address: unwrap.account, kind: "token", mint: unwrap.mint });
    });
  }

  transferSol(recipient: string | PublicKey, amount: HumanAmount): this {
    return this.addOperation(async (_ctx, tx) => {
      const destination =
        typeof recipient === "string" ? new PublicKey(recipient) : recipient;
      const input = toRawAmount(amount);
      if (input.asset.kind !== "native-sol")
        throw new Error("transferSol requires a native SOL amount");
      tx.add(transferSolIx(tx.payer(), destination, input.raw), {
        kind: "transfer-sol",
        recipient: destination,
        meta: { raw: input.raw.toString() },
      });
    });
  }

  transferToken(
    ref: TokenRef,
    recipient: string | PublicKey,
    amountRaw: bigint | "all",
  ): this {
    return this.addOperation(async (_ctx, tx) => {
      const token = await this.composerHost.resolveTokenForExecution(ref);
      const mint = new PublicKey(token.mint);
      const info = await readMint(this.composerHost.connection(), mint);
      const market = { mint, baseTokenProgram: info.tokenProgram };
      const destination =
        typeof recipient === "string" ? new PublicKey(recipient) : recipient;
      const sources =
        amountRaw === "all"
          ? (
              await listOwnedTokenAccounts(
                this.composerHost.connection(),
                tx.payer(),
              )
            )
              .filter(
                (account) =>
                  account.mint === token.mint && account.amountRaw > 0n,
              )
              .map((account) => ({
                source: new PublicKey(account.address),
                amount: account.amountRaw,
              }))
          : [{ source: undefined, amount: amountRaw }];
      if (!sources.length) throw new Error("No tokens available to transfer");
      for (const source of sources) {
        const transferAmount = source.amount;
        const transfer = transferTokenIxs({
          payer: tx.payer(),
          owner: tx.payer(),
          recipient: destination,
          mint: market.mint,
          amountRaw: transferAmount,
          decimals: info.decimals,
          tokenProgram: market.baseTokenProgram,
          source: source.source,
        });
        tx.addMany(transfer.instructions, {
          kind: "transfer-token",
          mint: market.mint,
          recipient: destination,
          meta: { raw: transferAmount.toString() },
        });
        tx.track({
          address: transfer.destination,
          kind: "token",
          mint: market.mint,
        });
      }
    });
  }

  /** This is generic chaining of a previous buy output; scripts may compose it into any strategy. */
  sendMinimumBoughtTokensTo(recipient: string | PublicKey): this {
    return this.addOperation(async (ctx, tx) => {
      if (!ctx.lastBuy)
        throw new Error("sendMinimumBoughtTokensTo() must follow buy()");
      const destination =
        typeof recipient === "string" ? new PublicKey(recipient) : recipient;
      const { token, market, minimumOutputRaw } = ctx.lastBuy;
      const transfer = transferTokenIxs({
        payer: tx.payer(),
        owner: tx.payer(),
        recipient: destination,
        mint: market.mint,
        amountRaw: minimumOutputRaw,
        decimals: decimalsOr(token.decimals, 6),
        tokenProgram: market.baseTokenProgram,
      });
      tx.addMany(transfer.instructions, {
        kind: "transfer-token",
        mint: market.mint,
        recipient: destination,
        meta: {
          raw: minimumOutputRaw.toString(),
          amountPolicy: "guaranteed-minimum",
        },
      });
      tx.track({
        address: transfer.destination,
        kind: "token",
        mint: market.mint,
      });
    });
  }

  /**
   * Split the slippage-guaranteed output from the immediately preceding buy
   * equally among recipients in the same atomic transaction.
   *
   * The indivisible raw-unit remainder and any execution upside stay with the
   * payer wallet. This is intentional: transfers may never exceed the buy's
   * guaranteed minimum output.
   */
  sendMinimumBoughtTokensEquallyTo(
    recipients: Array<string | PublicKey>,
  ): this {
    return this.addOperation(async (ctx, tx) => {
      if (!ctx.lastBuy) {
        throw new Error("sendMinimumBoughtTokensEquallyTo() must follow buy()");
      }

      if (recipients.length === 0) {
        throw new Error(
          "sendMinimumBoughtTokensEquallyTo() requires at least one recipient",
        );
      }

      const destinations = recipients.map((recipient) =>
        typeof recipient === "string" ? new PublicKey(recipient) : recipient,
      );
      const distinct = new Set(
        destinations.map((destination) => destination.toBase58()),
      );

      if (distinct.size !== destinations.length) {
        throw new Error(
          "sendMinimumBoughtTokensEquallyTo() recipients must be unique",
        );
      }

      const { token, market, minimumOutputRaw } = ctx.lastBuy;
      const amountRawEach = minimumOutputRaw / BigInt(destinations.length);
      const remainderRaw = minimumOutputRaw % BigInt(destinations.length);

      if (amountRawEach <= 0n) {
        throw new Error(
          "Bought minimum output is too small to split among recipients",
        );
      }

      for (const destination of destinations) {
        const transfer = transferTokenIxs({
          payer: tx.payer(),
          owner: tx.payer(),
          recipient: destination,
          mint: market.mint,
          amountRaw: amountRawEach,
          decimals: decimalsOr(token.decimals, 6),
          tokenProgram: market.baseTokenProgram,
        });

        tx.addMany(transfer.instructions, {
          kind: "transfer-token",
          mint: market.mint,
          recipient: destination,
          meta: {
            raw: amountRawEach.toString(),
            amountPolicy: "guaranteed-minimum-equal-split",
            splitRecipientCount: destinations.length,
            splitRemainderRaw: remainderRaw.toString(),
          },
        });

        tx.track({
          address: transfer.destination,
          kind: "token",
          mint: market.mint,
        });
      }
    });
  }

  /**
   * Split the slippage-guaranteed output from the immediately preceding buy
   * among recipients according to integer weights in the same atomic
   * transaction.
   *
   * Example:
   *   tx.buy("water", sol("0.05"), { slippageBps: 1500 });
   *   tx.sendMinimumBoughtTokensWeightedTo([
   *     { recipient: walletA, weightRaw: 100n }, // $1.00 target
   *     { recipient: walletB, weightRaw: 34n },  // $0.34 target
   *   ]);
   *
   * Any indivisible raw-unit remainder and any positive execution upside remain
   * with the payer. Transfers never exceed the buy's guaranteed minimum output.
   */
  sendMinimumBoughtTokensWeightedTo(
    allocations: Array<{
      recipient: string | PublicKey;
      weightRaw: bigint;
    }>,
  ): this {
    return this.addOperation(async (ctx, tx) => {
      if (!ctx.lastBuy) {
        throw new Error(
          "sendMinimumBoughtTokensWeightedTo() must follow buy()",
        );
      }

      if (allocations.length === 0) {
        throw new Error(
          "sendMinimumBoughtTokensWeightedTo() requires at least one allocation",
        );
      }

      const normalized = allocations.map((allocation) => ({
        recipient:
          typeof allocation.recipient === "string"
            ? new PublicKey(allocation.recipient)
            : allocation.recipient,
        weightRaw: allocation.weightRaw,
      }));

      const distinctRecipients = new Set(
        normalized.map((allocation) => allocation.recipient.toBase58()),
      );

      if (distinctRecipients.size !== normalized.length) {
        throw new Error(
          "sendMinimumBoughtTokensWeightedTo() recipients must be unique",
        );
      }

      if (normalized.some((allocation) => allocation.weightRaw <= 0n)) {
        throw new Error(
          "sendMinimumBoughtTokensWeightedTo() weights must be positive",
        );
      }

      const totalWeightRaw = normalized.reduce(
        (sum, allocation) => sum + allocation.weightRaw,
        0n,
      );
      const { token, market, minimumOutputRaw } = ctx.lastBuy;

      let distributedRaw = 0n;

      for (const allocation of normalized) {
        const amountRaw =
          (minimumOutputRaw * allocation.weightRaw) / totalWeightRaw;

        if (amountRaw <= 0n) {
          throw new Error(
            "Bought minimum output is too small for weighted distribution",
          );
        }

        distributedRaw += amountRaw;

        const transfer = transferTokenIxs({
          payer: tx.payer(),
          owner: tx.payer(),
          recipient: allocation.recipient,
          mint: market.mint,
          amountRaw,
          decimals: decimalsOr(token.decimals, 6),
          tokenProgram: market.baseTokenProgram,
        });

        tx.addMany(transfer.instructions, {
          kind: "transfer-token",
          mint: market.mint,
          recipient: allocation.recipient,
          meta: {
            raw: amountRaw.toString(),
            amountPolicy: "guaranteed-minimum-weighted-split",
            splitWeightRaw: allocation.weightRaw.toString(),
            splitTotalWeightRaw: totalWeightRaw.toString(),
          },
        });

        tx.track({
          address: transfer.destination,
          kind: "token",
          mint: market.mint,
        });
      }
    });
  }

  override async send(
    options: {
      via?: SenderId;
      kind?: string;
      skipSimulation?: boolean;
      skipPreflight?: boolean;
    } = {},
  ): Promise<SendReceipt> {
    await this.materialize();
    return await super.send(options);
  }
}

export class BatchComposer {
  private readonly composers: TransactionComposer[];
  constructor(
    private readonly host: ComposerHost,
    wallets: WalletRef[],
  ) {
    this.composers = wallets.map(
      (wallet) => new TransactionComposer(host, wallet),
    );
  }
  priorityFee(value: { cuLimit?: number; microLamports?: number }): this {
    this.composers.forEach((tx) => tx.priorityFee(value));
    return this;
  }
  buy(
    token: TokenRef,
    amount: HumanAmount,
    options?: {
      slippageBps?: number;
      minOutputRaw?: bigint | string;
      maxPriceSol?: SolPrice;
      reserves?: LivePoolReserves;
    },
  ): this {
    this.composers.forEach((tx) => tx.buy(token, amount, options));
    return this;
  }
  sell(
    token: TokenRef,
    options?: {
      bps?: number;
      amountRaw?: bigint | string;
      slippageBps?: number;
      minOutputLamports?: bigint | string;
      minPriceSol?: SolPrice;
      reserves?: LivePoolReserves;
      closeTokenAccount?: boolean;
    },
  ): this {
    this.composers.forEach((tx) => tx.sell(token, options));
    return this;
  }
  unwrapWsol(options: { skipMissing?: boolean } = {}): this {
    this.composers.forEach((tx) => tx.unwrapWsol(options));
    return this;
  }
  async build(): Promise<import("./types.ts").PlannedTransaction[]> {
    return await Promise.all(this.composers.map((tx) => tx.build()));
  }
  async send(
    options: {
      via?: SenderId;
      kind?: string;
      skipSimulation?: boolean;
      skipPreflight?: boolean;
    } = {},
  ): Promise<BatchSendReceipt> {
    return await this.host.sendBatchPlans(
      await this.build(),
      options.via ?? "rpc",
      options.kind,
      options,
    );
  }
}
