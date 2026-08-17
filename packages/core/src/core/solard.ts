import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { setTimeout as sleep } from "node:timers/promises";
import {
  AddressLookupTableProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
} from "@solana/web3.js";
import { AccountCache } from "../chain/account-cache.ts";
import { BlockhashCache } from "../chain/blockhash.ts";
import { SolardConnection } from "../chain/connection.ts";
import {
  listOwnedTokenAccounts,
  readMint,
  readTokenAmount,
  type OwnedTokenAccount,
} from "../chain/state.ts";
import { simulatePlanned } from "../chain/simulate.ts";
import { sameAsset, toRawAmount, type HumanAmount } from "../core/amounts.ts";
import { QuoteAssetMismatchError } from "../core/errors.ts";
import { optionalDecimals } from "../core/decimals.ts";
import type { GroupRef, TokenRef, WalletRef } from "../core/refs.ts";
import {
  LaunchSourceRegistry,
  type DiscoveredLaunch,
  type LaunchSourcePlugin,
  type WaitForLaunchArgs,
} from "../launches/launch-source.ts";
import {
  LaunchpadRegistry,
  type PendingMarketState,
  type PrepareDeploymentArgs,
  type PreparedPendingBuy,
  type PreparedTokenDeployment,
  type TokenLaunchpadPlugin,
} from "../launches/launchpad.ts";
import { measure } from "../core/log.ts";
import {
  simulationLog,
  submittedPlanLog,
  tokenLog,
} from "../core/log-result.ts";
import { measured } from "../core/measured.ts";
import { openDatabase, closeDatabase, resolveDbPath } from "../db/database.ts";
import { AgentRepo } from "../db/agent-repo.ts";
import { AltRepo } from "../db/alt-repo.ts";
import { ExecutionRepo } from "../db/execution-repo.ts";
import { PriceRepo, type PriceWindow } from "../db/price-repo.ts";
import { GroupRepo } from "../db/group-repo.ts";
import type { SolardDatabase, TokenRow } from "../db/schema.ts";
import { TokenRepo } from "../db/token-repo.ts";
import { WalletRepo, type WalletInfo } from "../db/wallet-repo.ts";
import { PositionStore } from "../runtime/positions.ts";
import { SolardAgent } from "../runtime/agent.ts";
import { SolardWatcher } from "../runtime/watcher.ts";
import { assembleTransaction } from "../tx/assemble.ts";
import { confirmSignature } from "../tx/confirm.ts";
import {
  BatchComposer,
  TransactionComposer,
  type ComposerHost,
} from "../tx/composer.ts";
import { HeliusSender } from "../tx/senders/helius-sender.ts";
import {
  isJitoBundleExpiredError,
  isJitoBundleGenerationRetryError,
  JitoBundleExpiredError,
  JitoBundleGenerationRetryError,
  JitoSender,
} from "../tx/senders/jito-sender.ts";
import { RpcSender } from "../tx/senders/rpc-sender.ts";
import {
  SenderRegistry,
  isBundleSender,
  type SolardSender,
} from "../tx/sender.ts";
import {
  SolardTransaction,
  TransactionBuilder,
} from "../tx/transaction-builder.ts";
import type {
  BatchSendReceipt,
  PlannedTransaction,
  SendOptions,
  SendReceipt,
  SenderId,
  SimulationResult,
  SubmittedPlan,
  TransactionDraft,
} from "../tx/types.ts";
import { VenueRegistry } from "../venues/route-resolver.ts";
import type { MarketPrice, TradeVenuePlugin } from "../venues/venue-plugin.ts";
import {
  ClaimSourceRegistry,
  type ClaimPlan,
  type ClaimSourcePlugin,
} from "../claims/claim-source.ts";
import { trace } from "../core/trace.ts";

const m = measure("sdk");
const BUNDLE_TRANSACTION_LIMIT = 5;
const JITO_TIP_ACCOUNTS = [
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
];

function jitoTipLamports(): bigint {
  const value = BigInt(process.env.JITO_TIP_LAMPORTS ?? "100000");
  if (value < 1000n) throw new Error("JITO_TIP_LAMPORTS must be at least 1000");
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("JITO_TIP_LAMPORTS exceeds JS safe integer range");
  return value;
}

function randomJitoTipAccount(): PublicKey {
  return new PublicKey(
    JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]!,
  );
}

function chunkPlans<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size)
    chunks.push(values.slice(index, index + size));
  return chunks;
}

export type SolardOptions = {
  rpcUrl?: string;
  dbPath?: string;
  cacheTtlMs?: number;
  venues?: TradeVenuePlugin[];
  claimSources?: ClaimSourcePlugin[];
  launchSources?: LaunchSourcePlugin[];
  launchpads?: TokenLaunchpadPlugin[];
  senders?: SolardSender[];
};
export class Solard implements ComposerHost {
  readonly db: SolardDatabase;
  readonly wallets: WalletRepo;
  readonly tokens: TokenRepo;
  readonly groups: GroupRepo;
  readonly executions: ExecutionRepo;
  readonly positions: PositionStore;
  readonly prices: PriceRepo;
  readonly alts: AltRepo;
  readonly watcher: SolardWatcher;
  readonly venues = new VenueRegistry();
  readonly claimSources = new ClaimSourceRegistry();
  readonly launches = new LaunchSourceRegistry();
  readonly launchpads = new LaunchpadRegistry();
  readonly senders = new SenderRegistry();
  readonly cache: AccountCache;
  readonly blockhash = new BlockhashCache();
  private readonly chain: SolardConnection;
  private readonly agentRepo: AgentRepo;
  private readonly dbPath: string;
  private closed = false;

  constructor(options: SolardOptions = {}) {
    trace("construct: opening database");
    this.dbPath = resolveDbPath(options.dbPath);
    this.db = openDatabase(this.dbPath);
    trace("construct: database ready");
    this.wallets = new WalletRepo(this.db);
    this.tokens = new TokenRepo(this.db);
    this.groups = new GroupRepo(this.db);
    this.executions = new ExecutionRepo(this.db);
    this.positions = new PositionStore(this.db);
    this.prices = new PriceRepo(this.db);
    this.alts = new AltRepo(this.db);
    this.agentRepo = new AgentRepo(this.db);
    this.chain = new SolardConnection(options.rpcUrl);
    this.cache = new AccountCache(options.cacheTtlMs);
    this.watcher = new SolardWatcher(this.db, () => this.connection());
    for (const venue of options.venues ?? []) this.venues.register(venue);
    for (const source of options.claimSources ?? [])
      this.claimSources.register(source);
    for (const source of options.launchSources ?? [])
      this.launches.register(source);
    for (const launchpad of options.launchpads ?? [])
      this.launchpads.register(launchpad);
    this.senders
      .register(new RpcSender())
      .register(new HeliusSender())
      .register(new JitoSender());
    for (const sender of options.senders ?? []) this.senders.register(sender);
    trace("construct: repositories, registries and senders ready");
  }

  connection(): Connection {
    return this.chain.get();
  }

  private async buildJitoTipTransaction(
    payer: PublicKey,
  ): Promise<VersionedTransaction> {
    const signer = this.signer(payer.toBase58());
    const { blockhash } =
      await this.connection().getLatestBlockhash("confirmed");
    const lamports = jitoTipLamports();

    const message = new TransactionMessage({
      payerKey: signer.publicKey,
      recentBlockhash: blockhash,
      instructions: [
        SystemProgram.transfer({
          fromPubkey: signer.publicKey,
          toPubkey: randomJitoTipAccount(),
          lamports: Number(lamports),
        }),
      ],
    }).compileToV0Message();

    const transaction = new VersionedTransaction(message);
    transaction.sign([signer]);
    return transaction;
  }
  registerVenue(plugin: TradeVenuePlugin): this {
    this.venues.register(plugin);
    return this;
  }
  registerClaimSource(plugin: ClaimSourcePlugin): this {
    this.claimSources.register(plugin);
    return this;
  }
  registerLaunchSource(plugin: LaunchSourcePlugin): this {
    this.launches.register(plugin);
    return this;
  }
  registerLaunchpad(plugin: TokenLaunchpadPlugin): this {
    this.launchpads.register(plugin);
    return this;
  }
  registerSender(sender: SolardSender): this {
    this.senders.register(sender);
    return this;
  }

  createWallet(name?: string): WalletInfo {
    return this.wallets.create(name);
  }
  importWallet(
    privateKey: string,
    name?: string,
    options?: import("../db/wallet-repo.ts").WalletImportOptions,
  ): WalletInfo {
    return this.wallets.import(privateKey, name, options);
  }
  listWallets(): WalletInfo[] {
    return this.wallets.list();
  }
  resolveWallet(ref: WalletRef) {
    return this.wallets.resolve(ref);
  }
  signer(ref: WalletRef): Keypair {
    return this.wallets.signer(ref).signer;
  }
  wallet(ref: WalletRef) {
    return this.resolveWallet(ref);
  }

  resolveToken(ref: TokenRef): TokenRow {
    return this.tokens.resolve(ref);
  }
  token(ref: TokenRef): TokenRow {
    return this.resolveToken(ref);
  }
  async addToken(
    mintRef: string,
    name?: string,
    metadata: Partial<TokenRow> = {},
  ): Promise<TokenRow> {
    return await measured(
      m,
      `add-token ${mintRef.slice(0, 8)}`,
      async () => {
        const mint = new PublicKey(mintRef);
        const chain = this.connection();
        const mintState = await readMint(chain, mint, this.cache);
        const inspected = await this.venues.inspect(chain, mint);
        return this.tokens.upsert({
          mint: mint.toBase58(),
          name: name ?? metadata.name ?? null,
          decimals: mintState.decimals,
          baseTokenProgram: mintState.tokenProgram.toBase58(),
          ...inspected,
          ...metadata,
          refreshedAtMs: Date.now(),
        });
      },
      tokenLog,
    );
  }
  configureToken(ref: TokenRef, patch: Partial<TokenRow>): TokenRow {
    const token = this.resolveToken(ref);
    return this.tokens.upsert({ ...token, ...patch, mint: token.mint });
  }
  async refreshToken(ref: TokenRef): Promise<TokenRow> {
    const token = this.resolveToken(ref);
    const mint = new PublicKey(token.mint);
    const mintState = await readMint(this.connection(), mint, this.cache);
    const inspected = await this.venues.inspect(this.connection(), mint);
    return this.tokens.upsert({
      ...token,
      ...inspected,
      mint: token.mint,
      decimals: mintState.decimals,
      baseTokenProgram: mintState.tokenProgram.toBase58(),
      refreshedAtMs: Date.now(),
    });
  }

  async route(token: TokenRow, user: PublicKey) {
    return await this.venues.resolve(this.connection(), token, user);
  }
  async resolveClaim(token: TokenRow, user: PublicKey): Promise<ClaimPlan> {
    return (await this.claimSources.resolve(this.connection(), token, user))
      .plan;
  }
  async waitForLaunch(
    sourceId: string,
    args: WaitForLaunchArgs,
  ): Promise<DiscoveredLaunch> {
    return await this.launches.wait(this.connection(), sourceId, args);
  }
  async persistLaunch(
    launch: DiscoveredLaunch,
    alias?: string,
  ): Promise<TokenRow> {
    const token = this.tokens.upsert({
      ...launch.token,
      name: alias ?? launch.name ?? launch.token.name ?? null,
      mint: launch.mint.toBase58(),
      refreshedAtMs: Date.now(),
    });
    return await this.refreshToken(token);
  }
  async prepareTokenDeployment(
    launchpadId: string,
    wallet: WalletRef,
    args: Omit<PrepareDeploymentArgs, "user">,
  ): Promise<PreparedTokenDeployment> {
    const user = this.signer(wallet).publicKey;
    return await this.launchpads
      .resolve(launchpadId)
      .prepareDeployment(this.connection(), { ...args, user });
  }
  async initialPendingMarketState(
    launchpadId: string,
    deployment: PreparedTokenDeployment,
  ): Promise<PendingMarketState> {
    const plugin = this.launchpads.resolve(launchpadId);
    if (!plugin.initialPendingMarketState)
      throw new Error(
        `Launchpad ${launchpadId} does not support pre-landing buys`,
      );
    return await plugin.initialPendingMarketState(
      this.connection(),
      deployment,
    );
  }
  async preparePendingBuy(
    launchpadId: string,
    deployment: PreparedTokenDeployment,
    buyer: WalletRef,
    amount: import("../core/amounts.ts").RawAmount,
    state: PendingMarketState,
    options: { slippageBps?: number } = {},
  ): Promise<PreparedPendingBuy> {
    const plugin = this.launchpads.resolve(launchpadId);
    if (!plugin.buildPendingBuy)
      throw new Error(
        `Launchpad ${launchpadId} does not support pre-landing buys`,
      );
    return await plugin.buildPendingBuy(
      this.connection(),
      deployment,
      this.signer(buyer).publicKey,
      amount,
      state,
      options,
    );
  }
  persistPreparedDeployment(
    deployment: PreparedTokenDeployment,
    alias?: string,
  ): TokenRow {
    return this.tokens.upsert({
      ...deployment.token,
      name: alias ?? deployment.token.name ?? null,
      mint: deployment.mint.publicKey.toBase58(),
      refreshedAtMs: Date.now(),
    });
  }
  async deployToken(
    launchpadId: string,
    wallet: WalletRef,
    args: Omit<PrepareDeploymentArgs, "user">,
    options: {
      alias?: string;
      via?: SenderId;
      skipSimulation?: boolean;
      skipPreflight?: boolean;
    } = {},
  ): Promise<{
    deployment: PreparedTokenDeployment;
    token: TokenRow;
    receipt: SendReceipt;
  }> {
    const deployment = await this.prepareTokenDeployment(
      launchpadId,
      wallet,
      args,
    );
    const builder = this.transaction(wallet)
      .addMany(deployment.instructions, {
        kind: "deploy-token",
        mint: deployment.mint.publicKey,
        meta: { launchpad: launchpadId, name: args.name, symbol: args.symbol },
      })
      .withSigner(deployment.mint);
    const receipt = await builder.send({
      via: options.via ?? "rpc",
      kind: `deploy:${launchpadId}`,
      skipSimulation: options.skipSimulation,
      skipPreflight: options.skipPreflight,
    });
    const token = this.persistPreparedDeployment(deployment, options.alias);
    return { deployment, token, receipt };
  }
  groupWallets(name: GroupRef): WalletRef[] {
    const memberships = this.groups.wallets(name);
    if (!memberships.length) throw new Error(`Group has no wallets: ${name}`);
    return memberships.map((row) => row.walletAddress);
  }
  async tokenAccounts(ref: WalletRef): Promise<OwnedTokenAccount[]> {
    const wallet = this.resolveWallet(ref);
    return await listOwnedTokenAccounts(this.connection(), wallet.address);
  }

  async tokenBalance(
    owner: PublicKey,
    token: TokenRow,
    tokenProgram: PublicKey,
  ): Promise<bigint> {
    return await readTokenAmount(
      this.connection(),
      owner,
      new PublicKey(token.mint),
      tokenProgram,
    );
  }

  async walletBalances(
    ref: WalletRef,
    tokenRefs: TokenRef[] = this.tokens.list(),
  ): Promise<{
    wallet: { name: string | null; address: string };
    solLamports: bigint;
    tokenBalances: Array<{
      token: TokenRow;
      amountRaw: bigint;
      decimals: number;
    }>;
    capturedAtMs: number;
  }> {
    const wallet = this.resolveWallet(ref);
    const connection = this.connection();
    const solLamports = BigInt(
      await connection.getBalance(wallet.address, "confirmed"),
    );
    const tokenBalances = await Promise.all(
      tokenRefs.map(async (tokenRef) => {
        const token = this.resolveToken(tokenRef);
        const storedDecimals = optionalDecimals(
          (token as TokenRow & { decimals: unknown }).decimals,
        );
        const mintState =
          token.baseTokenProgram && storedDecimals != null
            ? {
                tokenProgram: new PublicKey(token.baseTokenProgram),
                decimals: storedDecimals,
              }
            : await readMint(connection, new PublicKey(token.mint), this.cache);
        if (
          typeof (token as TokenRow & { decimals: unknown }).decimals !==
          "number"
        ) {
          this.tokens.upsert({
            mint: token.mint,
            decimals: mintState.decimals,
          });
        }
        const amountRaw = await this.tokenBalance(
          wallet.address,
          token,
          mintState.tokenProgram,
        );
        this.positions.recordBalance({
          walletAddress: wallet.address.toBase58(),
          mint: token.mint,
          amountRaw,
          decimals: mintState.decimals,
        });
        return {
          token: { ...token, decimals: mintState.decimals },
          amountRaw,
          decimals: mintState.decimals,
        };
      }),
    );
    return {
      wallet: {
        name: wallet.row?.name ?? null,
        address: wallet.address.toBase58(),
      },
      solLamports,
      tokenBalances,
      capturedAtMs: Date.now(),
    };
  }

  async quoteBuy(ref: TokenRef, amount: HumanAmount, slippageBps = 1500) {
    const token = this.resolveToken(ref);
    const user = PublicKey.default;
    const { plugin, market } = await this.route(token, user);
    const input = toRawAmount(amount);
    if (!sameAsset(input.asset, market.quoteAsset)) {
      throw new QuoteAssetMismatchError(
        input.asset.mint.toBase58(),
        market.quoteAsset.mint.toBase58(),
      );
    }
    const quote = await plugin.quoteBuy(
      { connection: this.connection(), token, user },
      market,
      input,
      slippageBps,
    );
    return { token, venue: market.venue, quoteAsset: market.quoteAsset, quote };
  }

  async samplePrice(ref: TokenRef): Promise<MarketPrice> {
    const token = this.resolveToken(ref);
    const { plugin, market } = await this.route(token, PublicKey.default);
    const sampled = await plugin.price(
      { connection: this.connection(), token, user: PublicKey.default },
      market,
    );
    this.prices.record({
      mint: token.mint,
      venue: sampled.venue,
      quoteMint: sampled.quoteAsset.mint.toBase58(),
      quoteKind: sampled.quoteAsset.kind,
      priceQuotePerToken: sampled.priceQuotePerToken,
      baseReserveRaw: sampled.baseReserveRaw?.toString() ?? null,
      quoteReserveRaw: sampled.quoteReserveRaw?.toString() ?? null,
      capturedAtMs: sampled.capturedAtMs,
    });
    return sampled;
  }

  averagePrice(ref: TokenRef, periodMs: number): PriceWindow {
    if (!Number.isFinite(periodMs) || periodMs <= 0)
      throw new Error("Price average period must be greater than zero");
    const token = this.resolveToken(ref);
    return this.prices.average(token.mint, periodMs);
  }

  async *watchPrices(
    refs: TokenRef[],
    options: {
      intervalMs?: number;
      averagePeriodMs?: number;
      signal?: AbortSignal;
    } = {},
  ): AsyncGenerator<{
    token: TokenRow;
    sample: MarketPrice;
    average: PriceWindow;
  }> {
    if (refs.length === 0)
      throw new Error("watchPrices requires at least one token");
    const intervalMs = options.intervalMs ?? 1_000;
    const averagePeriodMs = options.averagePeriodMs ?? 60_000;
    if (!Number.isFinite(intervalMs) || intervalMs < 250)
      throw new Error("Price interval must be at least 250ms");
    const tokens = refs.map((ref) => this.resolveToken(ref));
    while (!options.signal?.aborted) {
      for (const token of tokens) {
        const sample = await this.samplePrice(token);
        yield {
          token,
          sample,
          average: this.prices.average(token.mint, averagePeriodMs),
        };
      }
      if (!options.signal?.aborted)
        await sleep(intervalMs, undefined, { signal: options.signal }).catch(
          (error) => {
            if (!options.signal?.aborted) throw error;
          },
        );
    }
  }

  transaction(wallet: WalletRef): TransactionBuilder {
    return new TransactionBuilder(this, wallet);
  }
  tx(wallet: WalletRef): TransactionComposer {
    return new TransactionComposer(this, wallet);
  }
  composeMany(wallets: WalletRef[]): BatchComposer {
    return new BatchComposer(this, wallets);
  }
  group(name: GroupRef): SolardGroup {
    return new SolardGroup(
      this,
      name,
      this.groupWallets(name).map((ref) => String(ref)),
    );
  }

  async compile(
    payer: Keypair,
    draft: TransactionDraft,
    options: { useAlts?: boolean } = {},
  ): Promise<PlannedTransaction> {
    return await assembleTransaction({
      connection: this.connection(),
      blockhash: this.blockhash,
      payer,
      draft,
      altAddresses:
        options.useAlts === false
          ? []
          : this.alts.list().map((row) => new PublicKey(row.address)),
    });
  }
  async simulatePlan(plan: PlannedTransaction): Promise<SimulationResult> {
    return await simulatePlanned(this.connection(), plan);
  }
  async simulate(
    tx: SolardTransaction,
    wallet: WalletRef,
  ): Promise<SimulationResult> {
    return await this.simulatePlan(
      await this.compile(this.signer(wallet), tx.snapshot()),
    );
  }
  async send(
    tx: SolardTransaction,
    options: {
      wallet: WalletRef;
      via?: SenderId;
      kind?: string;
      skipSimulation?: boolean;
      skipPreflight?: boolean;
    },
  ): Promise<SendReceipt> {
    return await this.sendPlan(
      await this.compile(this.signer(options.wallet), tx.snapshot()),
      options.via ?? "rpc",
      options.kind,
      options,
    );
  }
  async broadcast(
    tx: SolardTransaction,
    options: {
      wallet: WalletRef;
      via?: SenderId;
      kind?: string;
      skipSimulation?: boolean;
      skipPreflight?: boolean;
    },
  ): Promise<SendReceipt> {
    return await this.send(tx, options);
  }
  async sendBatchPlans(
    plans: PlannedTransaction[],
    via: SenderId,
    kind = "batch",
    options: SendOptions = {},
  ): Promise<BatchSendReceipt> {
    if (plans.length === 0)
      throw new Error("Cannot send an empty transaction batch");
    const sender = this.senders.resolve(via);
    if (!isBundleSender(sender) || plans.length === 1) {
      return {
        sender: String(via),
        mode: "parallel",
        receipts: await Promise.all(
          plans.map((plan) => this.sendPlan(plan, via, kind, options)),
        ),
      };
    }

    const simulations = options.skipSimulation
      ? []
      : await Promise.all(plans.map((plan) => this.simulatePlan(plan)));
    const failed = simulations.find((simulation) => !simulation.success);
    if (failed)
      throw new Error(
        `Batch simulation failed: ${JSON.stringify(failed.error)}\n${failed.logs.join("\n")}`,
      );

    const records = plans.map((plan, index) =>
      this.executions.create(
        {
          signature: null,
          kind,
          status: options.skipSimulation ? "planned" : "simulated",
          walletAddress: plan.payer.toBase58(),
          mint:
            plan.draft.actions
              .find((action) => action.mint)
              ?.mint?.toBase58() ?? null,
          sender: String(via),
          venue: null,
          slot: null,
          error: null,
          metaJson: JSON.stringify({
            batchIndex: index,
            serializedSize: plan.serializedSize,
            simulation: simulations[index] ?? null,
            skipSimulation: options.skipSimulation === true,
          }),
        },
        plan.draft.actions,
      ),
    );

    try {
      const submissionIds: string[] = [];
      const signatures: string[] = [];
      const isJitoBundle = String(via) === "jito";
      const hasEmbeddedJitoTip = plans.some((plan) =>
        plan.draft.actions.some((action) => action.kind === "jito-tip"),
      );
      const chunkSize =
        isJitoBundle && !hasEmbeddedJitoTip
          ? BUNDLE_TRANSACTION_LIMIT - 1
          : BUNDLE_TRANSACTION_LIMIT;

      for (const chunk of chunkPlans(plans, chunkSize)) {
        const transactions = chunk.map((plan) => plan.transaction);

        if (isJitoBundle) {
          const chunkHasEmbeddedTip = chunk.some((plan) =>
            plan.draft.actions.some((action) => action.kind === "jito-tip"),
          );
          const bundleTransactions = chunkHasEmbeddedTip
            ? transactions
            : [
                await this.buildJitoTipTransaction(chunk[0]!.payer),
                ...transactions,
              ];
          const submission = await sender.sendBundle({
            connection: this.connection(),
            transactions: bundleTransactions,
          });
          submissionIds.push(submission.submissionId);
          signatures.push(
            ...submission.signatures.slice(chunkHasEmbeddedTip ? 0 : 1),
          );
        } else {
          const submission = await sender.sendBundle({
            connection: this.connection(),
            transactions,
          });
          submissionIds.push(submission.submissionId);
          signatures.push(...submission.signatures);
        }
      }
      const receipts =
        isJitoBundle && sender instanceof JitoSender
          ? await (async (): Promise<SendReceipt[]> => {
              if (submissionIds.length !== 1) {
                throw new Error(
                  `Expected one Jito bundle submission, got ${submissionIds.length}`,
                );
              }
              const landing = await sender.waitForBundle(submissionIds[0]!);
              if (landing.status === "expired") {
                throw new JitoBundleExpiredError(
                  landing.detail ??
                    `Jito bundle ${submissionIds[0]} exhausted its blockhash`,
                );
              }
              if (landing.status === "retry") {
                throw new JitoBundleGenerationRetryError(
                  landing.detail ??
                    `Jito bundle ${submissionIds[0]} needs a fresh tip generation`,
                );
              }
              if (landing.status !== "landed") {
                throw new Error(
                  landing.detail ??
                    `Jito bundle ${submissionIds[0]} ended with ${landing.status}`,
                );
              }
              return signatures.map((signature) => ({
                signature,
                slot: landing.slot,
                sender: String(via),
                status: "confirmed" as const,
              }));
            })()
          : await Promise.all(
              signatures.map((signature) =>
                confirmSignature(this.connection(), signature, String(via)),
              ),
            );
      receipts.forEach((receipt, index) =>
        this.executions.update(records[index]!, {
          signature: receipt.signature,
          status: receipt.status,
          slot: receipt.slot,
          error: receipt.error ?? null,
        }),
      );
      return {
        sender: String(via),
        mode: "bundle",
        submissionId: submissionIds.join(","),
        receipts,
      };
    } catch (error) {
      const retryGeneration =
        isJitoBundleExpiredError(error) ||
        isJitoBundleGenerationRetryError(error);
      for (const record of records)
        this.executions.update(record, {
          status: retryGeneration ? "planned" : "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      throw error;
    }
  }

  async broadcastPlan(
    plan: PlannedTransaction,
    via: SenderId,
    kind = "transaction",
    options: SendOptions = {},
  ): Promise<SubmittedPlan> {
    let simulation: SimulationResult | null = null;
    if (!options.skipSimulation) {
      simulation = await measured(
        m,
        `preflight ${via}`,
        async () => {
          const result = await this.simulatePlan(plan);
          if (!result.success)
            throw new Error(
              `Simulation failed: ${JSON.stringify(result.error)}\n${result.logs.join("\n")}`,
            );
          return result;
        },
        simulationLog,
      );
    }
    const execution = this.executions.create(
      {
        signature: null,
        kind,
        status: simulation ? "simulated" : "planned",
        walletAddress: plan.payer.toBase58(),
        mint: plan.draft.actions.find((a) => a.mint)?.mint?.toBase58() ?? null,
        sender: String(via),
        venue: null,
        slot: null,
        error: null,
        metaJson: JSON.stringify({
          serializedSize: plan.serializedSize,
          simulation,
          skipSimulation: options.skipSimulation === true,
        }),
      },
      plan.draft.actions,
    );
    return await measured(
      m,
      `submit ${via}`,
      async () => {
        try {
          const signature = await this.senders.resolve(via).send({
            connection: this.connection(),
            transaction: plan.transaction,
            options: {
              ...options,
              skipPreflight: options.skipPreflight ?? true,
            },
          });
          this.executions.update(execution, { signature, status: "broadcast" });
          return {
            signature,
            sender: String(via),
            executionId: execution.id,
            plan,
          };
        } catch (error) {
          this.executions.update(execution, {
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      },
      submittedPlanLog,
    );
  }

  async confirmSignature(
    signature: string,
    sender: SenderId | string = "rpc",
    timeoutMs = 30_000,
  ): Promise<SendReceipt> {
    const receipt = await confirmSignature(
      this.connection(),
      signature,
      String(sender),
      timeoutMs,
    );
    const execution = this.executions.findBySignature(signature);
    if (execution)
      this.executions.update(execution, {
        status: receipt.status,
        slot: receipt.slot,
        error: receipt.error ?? null,
      });
    return receipt;
  }

  async confirmSubmitted(
    submission: SubmittedPlan,
    timeoutMs = 30_000,
  ): Promise<SendReceipt> {
    const execution = this.executions.get(submission.executionId);
    const receipt = await confirmSignature(
      this.connection(),
      submission.signature,
      submission.sender,
      timeoutMs,
    );
    this.executions.update(execution, {
      status: receipt.status,
      slot: receipt.slot,
      error: receipt.error ?? null,
    });
    if (receipt.status === "confirmed") {
      const trackedMints = new Set(
        submission.plan.draft.actions
          .map((row) => row.mint?.toBase58())
          .filter((mint): mint is string => Boolean(mint)),
      );
      for (const mint of trackedMints) {
        try {
          const token = this.tokens.resolve(mint);
          const storedDecimals = optionalDecimals(
            (token as TokenRow & { decimals: unknown }).decimals,
          );
          const mintState =
            token.baseTokenProgram && storedDecimals != null
              ? {
                  tokenProgram: new PublicKey(token.baseTokenProgram),
                  decimals: storedDecimals,
                }
              : await readMint(
                  this.connection(),
                  new PublicKey(token.mint),
                  this.cache,
                );
          const balance = await this.tokenBalance(
            submission.plan.payer,
            token,
            mintState.tokenProgram,
          );
          this.positions.recordBalance({
            walletAddress: submission.plan.payer.toBase58(),
            mint,
            amountRaw: balance,
            decimals: mintState.decimals,
          });
          this.positions.upsert({
            walletAddress: submission.plan.payer.toBase58(),
            mint,
            tokenAmountRaw: balance,
            quoteMint: token.quoteMint ?? undefined,
          });
        } catch {}
      }
      for (const action of submission.plan.draft.actions.filter(
        (row) => row.kind === "claim",
      )) {
        const meta = action.meta ?? {};
        this.db.claims.insert({
          walletAddress: submission.plan.payer.toBase58(),
          mint: action.mint?.toBase58() ?? "",
          quoteMint: String(meta.quoteMint ?? ""),
          path: String(meta.path ?? "venue"),
          estimatedClaimRaw: String(meta.estimatedClaimRaw ?? "0"),
          claimedRaw: null,
          signature: receipt.signature,
          status: "confirmed",
          createdAtMs: Date.now(),
          updatedAtMs: Date.now(),
        });
      }
    }
    return receipt;
  }

  async sendPlan(
    plan: PlannedTransaction,
    via: SenderId,
    kind = "transaction",
    options: SendOptions = {},
  ): Promise<SendReceipt> {
    const submission = await this.broadcastPlan(plan, via, kind, options);
    return await this.confirmSubmitted(submission);
  }

  async buy(
    token: TokenRef,
    wallet: WalletRef,
    amount: HumanAmount,
    options: {
      slippageBps?: number;
      via?: SenderId;
      skipSimulation?: boolean;
      skipPreflight?: boolean;
    } = {},
  ) {
    return await this.tx(wallet)
      .buy(token, amount, options)
      .send({
        via: options.via ?? "rpc",
        kind: "buy",
        skipSimulation: options.skipSimulation,
        skipPreflight: options.skipPreflight,
      });
  }
  async buyMany(
    token: TokenRef,
    wallets: WalletRef[],
    amount: HumanAmount,
    options: {
      slippageBps?: number;
      via?: SenderId;
      skipSimulation?: boolean;
      skipPreflight?: boolean;
    } = {},
  ) {
    return await this.composeMany(wallets)
      .buy(token, amount, options)
      .send({
        via: options.via ?? "rpc",
        kind: "buy:many",
        skipSimulation: options.skipSimulation,
        skipPreflight: options.skipPreflight,
      });
  }
  async sell(
    token: TokenRef,
    wallet: WalletRef,
    options: {
      bps?: number;
      slippageBps?: number;
      via?: SenderId;
      skipSimulation?: boolean;
      skipPreflight?: boolean;
    } = {},
  ) {
    return await this.tx(wallet)
      .sell(token, options)
      .send({
        via: options.via ?? "rpc",
        kind: "sell",
        skipSimulation: options.skipSimulation,
        skipPreflight: options.skipPreflight,
      });
  }
  async sellMany(
    token: TokenRef,
    wallets: WalletRef[],
    options: {
      bps?: number;
      slippageBps?: number;
      via?: SenderId;
      skipSimulation?: boolean;
      skipPreflight?: boolean;
    } = {},
  ) {
    return await this.composeMany(wallets)
      .sell(token, options)
      .send({
        via: options.via ?? "rpc",
        kind: "sell:many",
        skipSimulation: options.skipSimulation,
        skipPreflight: options.skipPreflight,
      });
  }
  async unwrapWsol(
    wallet: WalletRef,
    options: {
      via?: SenderId;
      destination?: string | PublicKey;
      skipMissing?: boolean;
      skipSimulation?: boolean;
      skipPreflight?: boolean;
    } = {},
  ) {
    return await this.tx(wallet)
      .unwrapWsol({
        destination: options.destination,
        skipMissing: options.skipMissing,
      })
      .send({
        via: options.via ?? "rpc",
        kind: "unwrap-wsol",
        skipSimulation: options.skipSimulation,
        skipPreflight: options.skipPreflight,
      });
  }
  async unwrapWsolMany(
    wallets: WalletRef[],
    options: {
      via?: SenderId;
      skipMissing?: boolean;
      skipSimulation?: boolean;
      skipPreflight?: boolean;
    } = {},
  ) {
    return await this.composeMany(wallets)
      .unwrapWsol({ skipMissing: options.skipMissing })
      .send({
        via: options.via ?? "rpc",
        kind: "unwrap-wsol:many",
        skipSimulation: options.skipSimulation,
        skipPreflight: options.skipPreflight,
      });
  }
  async claim(
    token: TokenRef,
    wallet: WalletRef,
    options: { via?: SenderId } = {},
  ) {
    return await this.tx(wallet)
      .claimFees(token)
      .send({ via: options.via ?? "rpc", kind: "claim" });
  }

  listAgents() {
    return this.agentRepo.list();
  }
  configureAgent(name: string, config: Record<string, unknown>): SolardAgent {
    const row = this.agentRepo.configure(name, config);
    const wallet = config.wallet;
    if (typeof wallet !== "string")
      throw new Error("Agent config requires wallet: <wallet ref>");
    return new SolardAgent(row, this.agentRepo, this, wallet);
  }
  agent(name: string, wallet?: WalletRef): SolardAgent {
    const row = this.agentRepo.resolve(name);
    const config = this.agentRepo.config(row);
    const resolvedWallet =
      wallet ?? (typeof config.wallet === "string" ? config.wallet : undefined);
    if (!resolvedWallet)
      throw new Error(
        `Agent ${name} has no wallet. Configure it with slrd agent create ${name} --wallet <wallet>`,
      );
    return new SolardAgent(row, this.agentRepo, this, resolvedWallet);
  }
  watchToken(ref: TokenRef, label?: string) {
    return this.watcher.watchToken(this.resolveToken(ref).mint, label);
  }
  watchWallet(ref: WalletRef, label?: string) {
    return this.watcher.watchWallet(
      this.resolveWallet(ref).address.toBase58(),
      label,
    );
  }
  watchProgram(address: string | PublicKey, label?: string) {
    return this.watcher.watchProgram(
      typeof address === "string"
        ? new PublicKey(address).toBase58()
        : address.toBase58(),
      label,
    );
  }

  async createAlt(
    authority: WalletRef,
  ): Promise<{ address: string; receipt: SendReceipt }> {
    const signer = this.signer(authority);
    const slot = await this.connection().getSlot("confirmed");
    const [ix, address] = AddressLookupTableProgram.createLookupTable({
      authority: signer.publicKey,
      payer: signer.publicKey,
      recentSlot: slot,
    });
    const draft = this.transaction(signer)
      .add(ix, { kind: "alt-create", meta: { address: address.toBase58() } })
      .snapshot();
    const plan = await this.compile(signer, draft, { useAlts: false });
    const receipt = await this.sendPlan(plan, "rpc", "alt-create");
    if (receipt.status !== "failed") this.alts.register(address.toBase58());
    return { address: address.toBase58(), receipt };
  }
  async extendAlt(
    address: string,
    authority: WalletRef,
    accounts: string[],
  ): Promise<SendReceipt> {
    const signer = this.signer(authority);
    const ix = AddressLookupTableProgram.extendLookupTable({
      payer: signer.publicKey,
      authority: signer.publicKey,
      lookupTable: new PublicKey(address),
      addresses: accounts.map((value) => new PublicKey(value)),
    });
    const draft = this.transaction(signer)
      .add(ix, { kind: "alt-extend", meta: { address, accounts } })
      .snapshot();
    const plan = await this.compile(signer, draft, { useAlts: false });
    return await this.sendPlan(plan, "rpc", "alt-extend");
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeDatabase(this.dbPath);
  }
}
export class SolardGroup {
  constructor(
    private readonly slrd: Solard,
    readonly name: string,
    readonly walletAddresses: string[],
  ) {}
  buy(
    token: TokenRef,
    amount: HumanAmount,
    options: {
      slippageBps?: number;
      via?: SenderId;
      skipSimulation?: boolean;
      skipPreflight?: boolean;
    } = {},
  ) {
    return this.slrd
      .composeMany(this.walletAddresses)
      .buy(token, amount, options)
      .send({
        via: options.via ?? "rpc",
        kind: `group-buy:${this.name}`,
        skipSimulation: options.skipSimulation,
        skipPreflight: options.skipPreflight,
      });
  }
  sell(
    token: TokenRef,
    options: {
      bps?: number;
      slippageBps?: number;
      via?: SenderId;
      skipSimulation?: boolean;
      skipPreflight?: boolean;
    } = {},
  ) {
    return this.slrd
      .composeMany(this.walletAddresses)
      .sell(token, options)
      .send({
        via: options.via ?? "rpc",
        kind: `group-sell:${this.name}`,
        skipSimulation: options.skipSimulation,
        skipPreflight: options.skipPreflight,
      });
  }
  unwrapWsol(
    options: {
      via?: SenderId;
      skipMissing?: boolean;
      skipSimulation?: boolean;
      skipPreflight?: boolean;
    } = {},
  ) {
    return this.slrd
      .composeMany(this.walletAddresses)
      .unwrapWsol({ skipMissing: options.skipMissing })
      .send({
        via: options.via ?? "rpc",
        kind: `group-unwrap-wsol:${this.name}`,
        skipSimulation: options.skipSimulation,
        skipPreflight: options.skipPreflight,
      });
  }
}
