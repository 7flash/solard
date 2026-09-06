import { NATIVE_MINT, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
  type Commitment,
  type Connection,
} from "@solana/web3.js";
import {
  CREATE_CPMM_POOL_FEE_ACC,
  CREATE_CPMM_POOL_PROGRAM,
  LAUNCHPAD_PROGRAM,
  PlatformConfig,
  Raydium,
  TxVersion,
  getPdaLaunchpadPoolId,
} from "@raydium-io/raydium-sdk-v2";
import BN from "bn.js";

import type { WalletRef } from "../../core/refs.ts";
import { readMint } from "../../chain/state.ts";

const RAYDIUM_SWAP_API = "https://transaction-v1.raydium.io";
const RAYDIUM_API = "https://api-v3.raydium.io";
const RAYDIUM_LAUNCH_CONFIG_API =
  "https://launch-mint-v1.raydium.io/main/configs";

export type RaydiumTransaction = Transaction | VersionedTransaction;

export type RaydiumHost = {
  connection(): Connection;
  signer(ref: WalletRef): Keypair;
};

export type RaydiumExecutionOptions = {
  live?: boolean;
  simulate?: boolean;
  skipPreflight?: boolean;
  commitment?: Commitment;
  maxRetries?: number;
};

export type RaydiumSwapQuote = {
  id: string | null;
  inputMint: string;
  outputMint: string;
  inputRaw: bigint;
  outputRaw: bigint;
  minOutputRaw: bigint;
  slippageBps: number;
  priceImpactPct: number | null;
  routePlan: unknown[];
  raw: unknown;
};

export type RaydiumLaunchConfig = {
  id: string;
  name: string | null;
  mintB: string;
  mintBSymbol: string | null;
  mintBDecimals: number | null;
  curveType: number | null;
  migrateFee: string | null;
  tradeFeeRate: string | null;
  defaultSupply: string | null;
  defaultFundRaisingB: string | null;
  defaultSellA: string | null;
  raw: unknown;
};

export type RaydiumPreparedTransactions = {
  kind:
    | "swap"
    | "launchlab-create"
    | "launchlab-buy"
    | "launchlab-sell"
    | "cpmm-create";
  wallet: WalletRef;
  transactions: RaydiumTransaction[];
  extraSigners?: Keypair[];
  metadata: Record<string, unknown>;
};

export type RaydiumExecutionResult = {
  kind: RaydiumPreparedTransactions["kind"];
  simulated: boolean;
  live: boolean;
  signatures: string[];
  simulations: Array<{
    err: unknown;
    unitsConsumed: number | null;
    logs: string[];
  }>;
  metadata: Record<string, unknown>;
};

type RaydiumSwapApiEnvelope = {
  id?: string;
  success?: boolean;
  version?: string;
  msg?: string;
  data?: {
    swapType?: string;
    inputMint?: string;
    inputAmount?: string;
    outputMint?: string;
    outputAmount?: string;
    otherAmountThreshold?: string;
    slippageBps?: number;
    priceImpactPct?: number;
    routePlan?: unknown[];
  };
};

type ApiLaunchConfig = {
  key?: {
    name?: string;
    pubKey?: string;
    curveType?: number;
    migrateFee?: string;
    tradeFeeRate?: string;
    mintB?: string;
  };
  mintInfoB?: {
    symbol?: string;
    decimals?: number;
  };
  defaultParams?: {
    supplyInit?: string;
    totalFundRaisingB?: string;
    totalSellA?: string;
  };
};

function liveTradingEnabled(): boolean {
  return [
    "SOLARD_ENABLE_LIVE_TRADES",
    "SLRD_ENABLE_LIVE_TRADES",
    "SOLWAL_ENABLE_LIVE_TRADES",
  ].some((key) => process.env[key] === "1");
}

function assertLive(options: RaydiumExecutionOptions): void {
  if (options.live !== true) return;
  if (!liveTradingEnabled()) {
    throw new Error(
      "Raydium live writes require SOLARD_ENABLE_LIVE_TRADES=1 (legacy SLRD_/SOLWAL_ aliases are also accepted)",
    );
  }
}

function numberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length ? value : null;
}

function requiredBigint(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error(`Raydium response is missing ${label}`);
  }
  return BigInt(value);
}

async function fetchJson<T>(
  url: string,
  init?: RequestInit,
  timeoutMs = 15_000,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        accept: "application/json",
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
    });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    if (!response.ok) {
      throw new Error(
        `Raydium HTTP ${response.status}: ${typeof parsed === "string" ? parsed : JSON.stringify(parsed)}`,
      );
    }
    return parsed as T;
  } finally {
    clearTimeout(timer);
  }
}

function txRequiredSignerKeys(tx: RaydiumTransaction): Set<string> {
  if (tx instanceof VersionedTransaction) {
    const count = tx.message.header.numRequiredSignatures;
    return new Set(
      tx.message.staticAccountKeys.slice(0, count).map((key) => key.toBase58()),
    );
  }
  return new Set(tx.signatures.map((row) => row.publicKey.toBase58()));
}

function signTransaction(
  tx: RaydiumTransaction,
  signers: readonly Keypair[],
): void {
  const required = txRequiredSignerKeys(tx);
  const filtered = signers.filter((signer) =>
    required.has(signer.publicKey.toBase58()),
  );
  if (!filtered.length) return;
  if (tx instanceof VersionedTransaction) tx.sign(filtered);
  else tx.partialSign(...filtered);
}

function normalizedTransactions(value: any): RaydiumTransaction[] {
  if (Array.isArray(value?.transactions)) return value.transactions;
  if (value?.transaction) return [value.transaction];
  throw new Error("Raydium SDK did not return a transaction");
}

function cleanAddress(value: unknown): string | null {
  if (value instanceof PublicKey) return value.toBase58();
  if (value && typeof (value as any).toBase58 === "function") {
    return (value as any).toBase58();
  }
  return typeof value === "string" ? value : null;
}

function launchExtInfo(value: any): Record<string, unknown> {
  const address = value?.address ?? value?.addresses ?? {};
  const out: Record<string, unknown> = {};
  for (const key of [
    "poolId",
    "mintA",
    "mintB",
    "vaultA",
    "vaultB",
    "platformId",
    "configId",
  ]) {
    const encoded = cleanAddress(address?.[key] ?? value?.[key]);
    if (encoded) out[key] = encoded;
  }
  const decimalOutAmount = value?.decimalOutAmount;
  if (decimalOutAmount != null) out.expectedOut = decimalOutAmount.toString();
  return out;
}

function mintDescriptor(
  address: PublicKey,
  programId: PublicKey,
  decimals: number,
): any {
  return {
    address: address.toBase58(),
    programId: programId.toBase58(),
    decimals,
  };
}

export class RaydiumService {
  constructor(private readonly host: RaydiumHost) {}

  private async sdk(wallet: WalletRef): Promise<any> {
    return await Raydium.load({
      connection: this.host.connection(),
      owner: this.host.signer(wallet),
      cluster: "mainnet",
      disableLoadToken: false,
      blockhashCommitment: "confirmed",
    } as any);
  }

  async quoteExactIn(args: {
    inputMint: string;
    outputMint: string;
    amountRaw: bigint;
    slippageBps?: number;
  }): Promise<RaydiumSwapQuote> {
    const slippageBps = args.slippageBps ?? 100;
    if (args.amountRaw <= 0n)
      throw new Error("Raydium swap amount must be positive");
    if (
      !Number.isInteger(slippageBps) ||
      slippageBps < 0 ||
      slippageBps > 10_000
    ) {
      throw new Error("Raydium --slippage-bps must be an integer in 0..10000");
    }
    const query = new URLSearchParams({
      inputMint: args.inputMint,
      outputMint: args.outputMint,
      amount: args.amountRaw.toString(),
      slippageBps: String(slippageBps),
      txVersion: "V0",
    });
    const raw = await fetchJson<RaydiumSwapApiEnvelope>(
      `${RAYDIUM_SWAP_API}/compute/swap-base-in?${query}`,
    );
    if (raw.success === false || !raw.data) {
      throw new Error(`Raydium quote failed: ${raw.msg ?? "unknown error"}`);
    }
    return {
      id: stringOrNull(raw.id),
      inputMint: raw.data.inputMint ?? args.inputMint,
      outputMint: raw.data.outputMint ?? args.outputMint,
      inputRaw: requiredBigint(raw.data.inputAmount, "inputAmount"),
      outputRaw: requiredBigint(raw.data.outputAmount, "outputAmount"),
      minOutputRaw: requiredBigint(
        raw.data.otherAmountThreshold,
        "otherAmountThreshold",
      ),
      slippageBps: Number(raw.data.slippageBps ?? slippageBps),
      priceImpactPct: numberOrNull(raw.data.priceImpactPct),
      routePlan: Array.isArray(raw.data.routePlan) ? raw.data.routePlan : [],
      raw,
    };
  }

  private async priorityFeeMicroLamports(): Promise<string> {
    try {
      const raw = await fetchJson<any>(`${RAYDIUM_API}/main/auto-fee`);
      const defaults =
        raw?.data?.default ?? raw?.data?.data?.default ?? raw?.default;
      const value = defaults?.h ?? defaults?.m ?? defaults?.vh;
      if (value != null && Number.isFinite(Number(value))) return String(value);
    } catch {
      // Priority fee discovery is advisory. A caller can still explicitly set it.
    }
    return "0";
  }

  async buildSwapExactIn(args: {
    wallet: WalletRef;
    inputMint: string;
    outputMint: string;
    amountRaw: bigint;
    slippageBps?: number;
    computeUnitPriceMicroLamports?: bigint | number | string;
  }): Promise<RaydiumPreparedTransactions & { quote: RaydiumSwapQuote }> {
    const quote = await this.quoteExactIn(args);
    const owner = this.host.signer(args.wallet).publicKey;
    const inputMint = new PublicKey(args.inputMint);
    const outputMint = new PublicKey(args.outputMint);
    const inputIsSol = inputMint.equals(NATIVE_MINT);
    const outputIsSol = outputMint.equals(NATIVE_MINT);

    let inputAccount: string | undefined;
    let outputAccount: string | undefined;
    if (!inputIsSol) {
      const mint = await readMint(this.host.connection(), inputMint);
      const ata = getAssociatedTokenAddressSync(
        inputMint,
        owner,
        false,
        mint.tokenProgram,
      );
      if (!(await this.host.connection().getAccountInfo(ata, "confirmed"))) {
        throw new Error(
          `Raydium input token account does not exist: ${ata.toBase58()}`,
        );
      }
      inputAccount = ata.toBase58();
    }
    if (!outputIsSol) {
      const mint = await readMint(this.host.connection(), outputMint);
      const ata = getAssociatedTokenAddressSync(
        outputMint,
        owner,
        false,
        mint.tokenProgram,
      );
      // Leave outputAccount undefined when the ATA does not exist so the
      // Raydium transaction builder can include account creation.
      if (await this.host.connection().getAccountInfo(ata, "confirmed")) {
        outputAccount = ata.toBase58();
      }
    }

    const configuredPriority =
      args.computeUnitPriceMicroLamports ??
      process.env.SOLARD_RAYDIUM_PRIORITY_MICRO_LAMPORTS;
    const priorityMicroLamports =
      configuredPriority != null
        ? String(configuredPriority)
        : await this.priorityFeeMicroLamports();
    const body = {
      wallet: owner.toBase58(),
      // Raydium's current Trade API expects the complete compute response.
      swapResponse: quote.raw,
      txVersion: "V0",
      computeUnitPriceMicroLamports: priorityMicroLamports,
      wrapSol: inputIsSol,
      unwrapSol: outputIsSol,
      ...(inputAccount ? { inputAccount } : {}),
      ...(outputAccount ? { outputAccount } : {}),
    };
    const built = await fetchJson<any>(
      `${RAYDIUM_SWAP_API}/transaction/swap-base-in`,
      { method: "POST", body: JSON.stringify(body) },
    );
    if (built?.success === false) {
      throw new Error(
        `Raydium transaction build failed: ${built?.msg ?? "unknown error"}`,
      );
    }
    const rows = Array.isArray(built?.data)
      ? built.data
      : built?.data?.transaction
        ? [built.data]
        : [];
    const transactions = rows
      .map((row: any) => row?.transaction)
      .filter((value: unknown): value is string => typeof value === "string")
      .map((encoded: string) =>
        VersionedTransaction.deserialize(Buffer.from(encoded, "base64")),
      );
    if (!transactions.length) {
      throw new Error("Raydium transaction API returned no transactions");
    }
    return {
      kind: "swap",
      wallet: args.wallet,
      transactions,
      metadata: {
        inputMint: quote.inputMint,
        outputMint: quote.outputMint,
        inputRaw: quote.inputRaw.toString(),
        expectedOutputRaw: quote.outputRaw.toString(),
        minOutputRaw: quote.minOutputRaw.toString(),
        priceImpactPct: quote.priceImpactPct,
        routePlan: quote.routePlan,
      },
      quote,
    };
  }

  async listLaunchConfigs(): Promise<RaydiumLaunchConfig[]> {
    const response = await fetchJson<any>(RAYDIUM_LAUNCH_CONFIG_API);
    const rows: ApiLaunchConfig[] = Array.isArray(response?.data)
      ? response.data
      : Array.isArray(response?.data?.data)
        ? response.data.data
        : Array.isArray(response)
          ? response
          : [];
    return rows
      .map((row) => ({
        id: row.key?.pubKey ?? "",
        name: stringOrNull(row.key?.name),
        mintB: row.key?.mintB ?? "",
        mintBSymbol: stringOrNull(row.mintInfoB?.symbol),
        mintBDecimals: numberOrNull(row.mintInfoB?.decimals),
        curveType: numberOrNull(row.key?.curveType),
        migrateFee: stringOrNull(row.key?.migrateFee),
        tradeFeeRate: stringOrNull(row.key?.tradeFeeRate),
        defaultSupply: stringOrNull(row.defaultParams?.supplyInit),
        defaultFundRaisingB: stringOrNull(row.defaultParams?.totalFundRaisingB),
        defaultSellA: stringOrNull(row.defaultParams?.totalSellA),
        raw: row,
      }))
      .filter((row) => row.id && row.mintB);
  }

  async resolveLaunchConfig(args: {
    quoteMint: string;
    configId?: string;
  }): Promise<RaydiumLaunchConfig> {
    const configs = await this.listLaunchConfigs();
    const selected = args.configId
      ? configs.find((row) => row.id === args.configId)
      : configs.find((row) => row.mintB === args.quoteMint);
    if (selected) {
      if (selected.mintB !== args.quoteMint) {
        throw new Error(
          `Raydium LaunchLab config ${selected.id} uses quote ${selected.mintB}, not ${args.quoteMint}`,
        );
      }
      return selected;
    }
    const quotes = [...new Set(configs.map((row) => row.mintB))];
    throw new Error(
      `No Raydium LaunchLab config exists for quote mint ${args.quoteMint}. ` +
        `LaunchLab can only use an on-chain configured quote mint. Available quote mints: ${quotes.join(", ") || "none"}. ` +
        `Use 'slrd raydium cpmm create' for an arbitrary SPL/SPL pair.`,
    );
  }

  async buildLaunchLabCreate(args: {
    wallet: WalletRef;
    mintSigner: Keypair;
    name: string;
    symbol: string;
    uri: string;
    quoteMint: string;
    buyAmountRaw?: bigint;
    decimals?: number;
    slippageBps?: number;
    configId?: string;
    token2022?: boolean;
  }): Promise<RaydiumPreparedTransactions> {
    const config = await this.resolveLaunchConfig({
      quoteMint: args.quoteMint,
      configId: args.configId,
    });
    const quoteMint = new PublicKey(config.mintB);
    const quoteInfo = await readMint(this.host.connection(), quoteMint);
    const raydium = await this.sdk(args.wallet);
    const buyAmountRaw = args.buyAmountRaw ?? 0n;
    // Some LaunchLab SDK releases validate buyAmount before honoring createOnly.
    // A one-raw-unit placeholder keeps create-only launches compatible without
    // adding a buy instruction or spending quote inventory.
    const builderBuyAmountRaw = buyAmountRaw === 0n ? 1n : buyAmountRaw;
    const built = await raydium.launchpad.createLaunchpad({
      mintA: args.mintSigner.publicKey,
      name: args.name,
      symbol: args.symbol,
      uri: args.uri,
      buyAmount: new BN(builderBuyAmountRaw.toString()),
      configId: new PublicKey(config.id),
      decimals: args.decimals ?? 6,
      mintBDecimals: quoteInfo.decimals,
      slippage: new BN(String(args.slippageBps ?? 100)),
      migrateType: "cpmm",
      createOnly: buyAmountRaw === 0n,
      txVersion: TxVersion.V0,
      extraSigners: [args.mintSigner],
      token2022: args.token2022 === true,
    });
    const transactions = normalizedTransactions(built);
    return {
      kind: "launchlab-create",
      wallet: args.wallet,
      transactions,
      extraSigners: [args.mintSigner],
      metadata: {
        mint: args.mintSigner.publicKey.toBase58(),
        name: args.name,
        symbol: args.symbol,
        uri: args.uri,
        quoteMint: config.mintB,
        configId: config.id,
        initialBuyRaw: buyAmountRaw.toString(),
        ...launchExtInfo(built.extInfo),
      },
    };
  }

  private async launchPoolContext(args: {
    wallet: WalletRef;
    mint: string;
    quoteMint: string;
  }): Promise<{
    raydium: any;
    mintA: PublicKey;
    mintB: PublicKey;
    mintAProgram: PublicKey;
    poolInfo: any;
    platformFeeRate: BN;
  }> {
    const raydium = await this.sdk(args.wallet);
    const mintA = new PublicKey(args.mint);
    const mintB = new PublicKey(args.quoteMint);
    const mintAInfo = await readMint(this.host.connection(), mintA);
    const poolId = getPdaLaunchpadPoolId(
      LAUNCHPAD_PROGRAM,
      mintA,
      mintB,
    ).publicKey;
    const poolInfo = await raydium.launchpad.getRpcPoolInfo({ poolId });
    const platformAccount = await this.host
      .connection()
      .getAccountInfo(poolInfo.platformId, "confirmed");
    if (!platformAccount) {
      throw new Error(
        `Raydium LaunchLab platform account not found: ${poolInfo.platformId}`,
      );
    }
    const platformInfo = PlatformConfig.decode(platformAccount.data);
    return {
      raydium,
      mintA,
      mintB,
      mintAProgram: mintAInfo.tokenProgram,
      poolInfo,
      platformFeeRate: platformInfo.feeRate,
    };
  }

  async buildLaunchLabBuy(args: {
    wallet: WalletRef;
    mint: string;
    quoteMint: string;
    amountRaw: bigint;
    slippageBps?: number;
  }): Promise<RaydiumPreparedTransactions> {
    if (args.amountRaw <= 0n)
      throw new Error("LaunchLab buy amount must be positive");
    const ctx = await this.launchPoolContext(args);
    const built = await ctx.raydium.launchpad.buyToken({
      programId: LAUNCHPAD_PROGRAM,
      mintA: ctx.mintA,
      mintAProgram: ctx.mintAProgram,
      mintB: ctx.mintB,
      poolInfo: ctx.poolInfo,
      configInfo: ctx.poolInfo.configInfo,
      platformFeeRate: ctx.platformFeeRate,
      buyAmount: new BN(args.amountRaw.toString()),
      slippage: new BN(String(args.slippageBps ?? 100)),
      txVersion: TxVersion.V0,
    });
    return {
      kind: "launchlab-buy",
      wallet: args.wallet,
      transactions: normalizedTransactions(built),
      metadata: {
        mint: args.mint,
        quoteMint: args.quoteMint,
        inputRaw: args.amountRaw.toString(),
        ...launchExtInfo(built.extInfo),
      },
    };
  }

  async buildLaunchLabSell(args: {
    wallet: WalletRef;
    mint: string;
    quoteMint: string;
    amountRaw: bigint;
    slippageBps?: number;
  }): Promise<RaydiumPreparedTransactions> {
    if (args.amountRaw <= 0n)
      throw new Error("LaunchLab sell amount must be positive");
    const ctx = await this.launchPoolContext(args);
    const built = await ctx.raydium.launchpad.sellToken({
      programId: LAUNCHPAD_PROGRAM,
      mintA: ctx.mintA,
      mintAProgram: ctx.mintAProgram,
      mintB: ctx.mintB,
      poolInfo: ctx.poolInfo,
      configInfo: ctx.poolInfo.configInfo,
      platformFeeRate: ctx.platformFeeRate,
      sellAmount: new BN(args.amountRaw.toString()),
      slippage: new BN(String(args.slippageBps ?? 100)),
      txVersion: TxVersion.V0,
    });
    return {
      kind: "launchlab-sell",
      wallet: args.wallet,
      transactions: normalizedTransactions(built),
      metadata: {
        mint: args.mint,
        quoteMint: args.quoteMint,
        inputRaw: args.amountRaw.toString(),
        ...launchExtInfo(built.extInfo),
      },
    };
  }

  async buildCpmmCreate(args: {
    wallet: WalletRef;
    mintA: string;
    mintB: string;
    amountARaw: bigint;
    amountBRaw: bigint;
    feeConfigIndex?: number;
    startTime?: number;
  }): Promise<RaydiumPreparedTransactions> {
    if (args.amountARaw <= 0n || args.amountBRaw <= 0n) {
      throw new Error("CPMM initial amounts must both be positive");
    }
    const raydium = await this.sdk(args.wallet);
    const mintAPubkey = new PublicKey(args.mintA);
    const mintBPubkey = new PublicKey(args.mintB);
    const [mintAInfo, mintBInfo, feeConfigs] = await Promise.all([
      readMint(this.host.connection(), mintAPubkey),
      readMint(this.host.connection(), mintBPubkey),
      raydium.api.getCpmmConfigs(),
    ]);
    const feeConfig =
      feeConfigs.find((row: any) => row.index === (args.feeConfigIndex ?? 0)) ??
      feeConfigs[args.feeConfigIndex ?? 0] ??
      feeConfigs[0];
    if (!feeConfig) throw new Error("Raydium returned no CPMM fee configs");
    const built = await raydium.cpmm.createPool({
      programId: CREATE_CPMM_POOL_PROGRAM,
      poolFeeAccount: CREATE_CPMM_POOL_FEE_ACC,
      mintA: mintDescriptor(
        mintAPubkey,
        mintAInfo.tokenProgram,
        mintAInfo.decimals,
      ),
      mintB: mintDescriptor(
        mintBPubkey,
        mintBInfo.tokenProgram,
        mintBInfo.decimals,
      ),
      mintAAmount: new BN(args.amountARaw.toString()),
      mintBAmount: new BN(args.amountBRaw.toString()),
      startTime: new BN(String(args.startTime ?? 0)),
      feeConfig,
      addSupportMintExt: true,
      associatedOnly: true,
      ownerInfo: { useSOLBalance: true },
      txVersion: TxVersion.V0,
    });
    return {
      kind: "cpmm-create",
      wallet: args.wallet,
      transactions: normalizedTransactions(built),
      metadata: {
        mintA: args.mintA,
        mintB: args.mintB,
        amountARaw: args.amountARaw.toString(),
        amountBRaw: args.amountBRaw.toString(),
        feeConfigIndex: feeConfig.index ?? null,
        ...launchExtInfo(built.extInfo),
      },
    };
  }

  async executePrepared(
    prepared: RaydiumPreparedTransactions,
    options: RaydiumExecutionOptions = {},
  ): Promise<RaydiumExecutionResult> {
    assertLive(options);
    const connection = this.host.connection();
    const owner = this.host.signer(prepared.wallet);
    const commitment = options.commitment ?? "confirmed";
    const simulations: RaydiumExecutionResult["simulations"] = [];
    const signatures: string[] = [];

    for (let index = 0; index < prepared.transactions.length; index += 1) {
      const tx = prepared.transactions[index]!;
      signTransaction(tx, [owner, ...(prepared.extraSigners ?? [])]);
      if (options.simulate !== false) {
        const simulated = await connection.simulateTransaction(
          tx as any,
          {
            sigVerify: true,
            replaceRecentBlockhash: false,
            commitment,
          } as any,
        );
        simulations.push({
          err: simulated.value.err,
          unitsConsumed: simulated.value.unitsConsumed ?? null,
          logs: simulated.value.logs ?? [],
        });
        if (
          simulated.value.err &&
          (options.live === true ||
            prepared.transactions.length === 1 ||
            index === 0)
        ) {
          throw new Error(
            `Raydium ${prepared.kind} simulation failed: ${JSON.stringify(simulated.value.err)}`,
          );
        }
      }
      if (options.live === true) {
        const signature = await connection.sendRawTransaction(tx.serialize(), {
          skipPreflight: options.skipPreflight ?? false,
          preflightCommitment: commitment,
          maxRetries: options.maxRetries ?? 3,
        });
        await connection.confirmTransaction(signature, commitment);
        signatures.push(signature);
      }
    }

    return {
      kind: prepared.kind,
      simulated: options.simulate !== false,
      live: options.live === true,
      signatures,
      simulations,
      metadata: prepared.metadata,
    };
  }
}
