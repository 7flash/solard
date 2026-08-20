import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

import { BrowserSolardStore, defaultBrowserStorage } from "./storage.ts";
import {
  buildJupiterDirectSwap,
  type JupiterBrowserConfig,
} from "./jupiter.ts";
import type {
  BrowserBroadcastResult,
  BrowserPortfolio,
  BrowserSolardOptions,
  BrowserSwapBuild,
  BrowserSwapResult,
  BrowserTokenBalance,
  BrowserWalletSigner,
} from "./types.ts";

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM_ID =
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHn5qCXEpPxuEb";

const CANONICAL_LABELS: Record<string, string> = {
  [SOL_MINT]: "WSOL",
  [USDC_MINT]: "USDC",
};

function createRateLimitedFetch(
  rawFetch: typeof globalThis.fetch,
  maxRps: number,
): typeof globalThis.fetch {
  const rps = Math.max(0.1, maxRps);
  const spacingMs = Math.ceil(1000 / rps) + 2;
  let tail = Promise.resolve();
  let nextAt = 0;

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    let release!: () => void;
    const previous = tail;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      const delay = Math.max(0, nextAt - Date.now());
      if (delay > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
      nextAt = Date.now() + spacingMs;
    } finally {
      release();
    }
    return await rawFetch(input, init);
  }) as typeof globalThis.fetch;
}

function requireFetch(
  supplied?: typeof globalThis.fetch,
): typeof globalThis.fetch {
  const value = supplied ?? globalThis.fetch;
  if (!value) throw new Error("Browser fetch() is unavailable.");
  return value.bind(globalThis);
}

function lamportsFromSol(value: string | number): bigint {
  const text = String(value).trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) {
    throw new Error(`Invalid SOL amount: ${text}`);
  }
  const [whole = "0", fraction = ""] = text.split(".");
  if (fraction.length > 9) {
    throw new Error("SOL amount supports at most 9 decimal places.");
  }
  return (
    BigInt(whole) * 1_000_000_000n +
    BigInt((fraction + "000000000").slice(0, 9))
  );
}

function formatRaw(raw: bigint, decimals: number): string {
  if (decimals <= 0) return raw.toString();
  const unit = 10n ** BigInt(decimals);
  const whole = raw / unit;
  const fraction = (raw % unit)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""}`;
}

export class BrowserSolard {
  readonly connection: Connection;
  readonly store: BrowserSolardStore;
  readonly contacts;
  readonly tokens;

  private wallet: BrowserWalletSigner | null;
  private readonly jupiter: JupiterBrowserConfig;

  constructor(readonly options: BrowserSolardOptions) {
    const rawFetch = requireFetch(options.fetch);
    const rpcFetch = createRateLimitedFetch(rawFetch, options.rpcMaxRps ?? 5);

    this.connection = new Connection(options.rpcUrl, {
      commitment: options.commitment ?? "confirmed",
      disableRetryOnRateLimit: true,
      fetch: rpcFetch,
    });

    this.wallet = options.wallet ?? null;
    this.store = new BrowserSolardStore(
      options.storage ?? defaultBrowserStorage(),
      options.storageNamespace ?? "solard:browser:v1",
    );

    this.contacts = {
      list: () => this.store.listContacts(),
      add: (
        name: string,
        address: string,
        addOptions?: { overwrite?: boolean },
      ) => this.store.addContact(name, address, addOptions),
      find: (ref: string) => this.store.findContact(ref),
      remove: (ref: string) => this.store.removeContact(ref),
      resolve: (ref: string) => this.store.resolveDestination(ref),
    };

    this.tokens = {
      list: () => this.store.listTokenAliases(),
      register: (
        alias: string,
        mint: string,
        registerOptions?: { overwrite?: boolean },
      ) => this.store.registerToken(alias, mint, registerOptions),
      resolve: (ref: string) => this.store.resolveToken(ref),
    };

    const jupiterRps =
      options.jupiterMaxRps ?? (options.jupiterApiKey ? 1 : 0.5);
    this.jupiter = {
      baseUrl: options.jupiterBaseUrl,
      apiKey: options.jupiterApiKey,
      fetch: createRateLimitedFetch(rawFetch, jupiterRps),
    };
  }

  setWallet(wallet: BrowserWalletSigner | null): void {
    this.wallet = wallet;
  }

  get publicKey(): PublicKey | null {
    return this.wallet?.publicKey ?? null;
  }

  private signer(): BrowserWalletSigner {
    if (!this.wallet?.publicKey) {
      throw new Error(
        "A connected browser wallet is required for this operation.",
      );
    }
    return this.wallet;
  }

  async connectWallet(): Promise<PublicKey> {
    const wallet = this.signer();
    await wallet.connect?.();
    if (!wallet.publicKey) {
      throw new Error("Browser wallet connected without a public key.");
    }
    return wallet.publicKey;
  }

  resolveDestination(ref: string): string {
    return this.store.resolveDestination(ref);
  }

  resolveToken(ref: string): string {
    return this.store.resolveToken(ref);
  }

  async getPortfolio(address?: string | PublicKey): Promise<BrowserPortfolio> {
    const owner =
      address instanceof PublicKey
        ? address
        : address
          ? new PublicKey(address)
          : this.signer().publicKey!;

    const [solLamportsNumber, spl, token2022] = await Promise.all([
      this.connection.getBalance(owner, "confirmed"),
      this.connection.getParsedTokenAccountsByOwner(
        owner,
        { programId: new PublicKey(TOKEN_PROGRAM_ID) },
        "confirmed",
      ),
      this.connection.getParsedTokenAccountsByOwner(
        owner,
        { programId: new PublicKey(TOKEN_2022_PROGRAM_ID) },
        "confirmed",
      ),
    ]);

    const aggregate = new Map<
      string,
      {
        amountRaw: bigint;
        decimals: number;
        program: "spl-token" | "token-2022";
        accounts: string[];
      }
    >();

    for (const [program, response] of [
      ["spl-token", spl] as const,
      ["token-2022", token2022] as const,
    ]) {
      for (const account of response.value) {
        const info = (account.account.data as any)?.parsed?.info;
        const amount = info?.tokenAmount;
        const mint = String(info?.mint ?? "");
        const raw = String(amount?.amount ?? "0");
        if (!mint || !/^\d+$/.test(raw)) continue;
        const amountRaw = BigInt(raw);
        if (amountRaw === 0n) continue;
        const decimals = Number(amount?.decimals ?? 0);

        const existing = aggregate.get(mint);
        if (existing) {
          existing.amountRaw += amountRaw;
          existing.accounts.push(account.pubkey.toBase58());
        } else {
          aggregate.set(mint, {
            amountRaw,
            decimals,
            program,
            accounts: [account.pubkey.toBase58()],
          });
        }
      }
    }

    const aliases = new Map(
      this.store
        .listTokenAliases()
        .map((row) => [row.mint, row.alias] as const),
    );
    const tokenBalances: BrowserTokenBalance[] = [...aggregate.entries()]
      .map(([mint, row]) => ({
        mint,
        amountRaw: row.amountRaw,
        amountUi: formatRaw(row.amountRaw, row.decimals),
        decimals: row.decimals,
        program: row.program,
        label: CANONICAL_LABELS[mint] ?? aliases.get(mint) ?? mint,
        tokenAccounts: row.accounts,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));

    return {
      address: owner.toBase58(),
      solLamports: BigInt(solLamportsNumber),
      tokenBalances,
    };
  }

  async signAndBroadcast(
    transaction: VersionedTransaction,
    strategy: {
      blockhash: string;
      lastValidBlockHeight: number;
      skipPreflight?: boolean;
    },
  ): Promise<BrowserBroadcastResult> {
    const wallet = this.signer();
    const signed = await wallet.signTransaction(transaction);
    if (!(signed instanceof VersionedTransaction)) {
      throw new Error("Browser wallet did not return a VersionedTransaction.");
    }

    const signature = await this.connection.sendRawTransaction(
      signed.serialize(),
      {
        skipPreflight: strategy.skipPreflight ?? false,
        preflightCommitment: "confirmed",
        maxRetries: 0,
      },
    );

    const confirmation = await this.connection.confirmTransaction(
      {
        signature,
        blockhash: strategy.blockhash,
        lastValidBlockHeight: strategy.lastValidBlockHeight,
      },
      "confirmed",
    );

    if (confirmation.value.err) {
      throw new Error(
        `Transaction ${signature} failed: ${JSON.stringify(confirmation.value.err)}`,
      );
    }

    return {
      signature,
      confirmed: true,
      blockhash: strategy.blockhash,
      lastValidBlockHeight: strategy.lastValidBlockHeight,
    };
  }

  async sendSol(
    destinationRef: string,
    amountSol: string | number,
  ): Promise<BrowserBroadcastResult> {
    const wallet = this.signer();
    const destination = new PublicKey(
      this.store.resolveDestination(destinationRef),
    );
    const lamports = lamportsFromSol(amountSol);
    if (lamports <= 0n)
      throw new Error("SOL transfer amount must be positive.");
    if (lamports > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(
        "SOL transfer amount is too large for SystemProgram.transfer.",
      );
    }

    const latest = await this.connection.getLatestBlockhash("confirmed");
    const message = new TransactionMessage({
      payerKey: wallet.publicKey!,
      recentBlockhash: latest.blockhash,
      instructions: [
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey!,
          toPubkey: destination,
          lamports: Number(lamports),
        }),
      ],
    }).compileToV0Message();

    return await this.signAndBroadcast(
      new VersionedTransaction(message),
      latest,
    );
  }

  async buildSwap(args: {
    inputMint: string;
    outputMint: string;
    amountRaw: bigint | string;
    slippageBps?: number | "rtse";
    mode?: "fast";
    simulate?: boolean;
  }): Promise<BrowserSwapBuild> {
    const wallet = this.signer();
    return await buildJupiterDirectSwap({
      connection: this.connection,
      config: this.jupiter,
      options: {
        inputMint: this.resolveTokenOrMint(args.inputMint),
        outputMint: this.resolveTokenOrMint(args.outputMint),
        amountRaw: args.amountRaw,
        taker: wallet.publicKey!.toBase58(),
        slippageBps: args.slippageBps,
        mode: args.mode,
        wrapAndUnwrapSol: true,
      },
      simulate: args.simulate,
    });
  }

  async swap(args: {
    inputMint: string;
    outputMint: string;
    amountRaw: bigint | string;
    slippageBps?: number | "rtse";
    mode?: "fast";
    simulate?: boolean;
    skipPreflight?: boolean;
  }): Promise<BrowserSwapResult> {
    const build = await this.buildSwap(args);
    const broadcast = await this.signAndBroadcast(build.transaction, {
      blockhash: build.blockhash,
      lastValidBlockHeight: build.lastValidBlockHeight,
      skipPreflight: args.skipPreflight,
    });

    return {
      ...broadcast,
      inputMint: build.inputMint,
      outputMint: build.outputMint,
      inAmount: build.inAmount,
      quotedOutAmount: build.outAmount,
    };
  }

  async buyWithSol(args: {
    outputMint: string;
    sol: string | number;
    slippageBps?: number | "rtse";
  }): Promise<BrowserSwapResult> {
    return await this.swap({
      inputMint: SOL_MINT,
      outputMint: args.outputMint,
      amountRaw: lamportsFromSol(args.sol),
      slippageBps: args.slippageBps,
    });
  }

  async sellToSol(args: {
    inputMint: string;
    amountRaw: bigint | string;
    slippageBps?: number | "rtse";
  }): Promise<BrowserSwapResult> {
    return await this.swap({
      inputMint: args.inputMint,
      outputMint: SOL_MINT,
      amountRaw: args.amountRaw,
      slippageBps: args.slippageBps,
    });
  }

  private resolveTokenOrMint(value: string): string {
    try {
      return new PublicKey(value).toBase58();
    } catch {
      return this.store.resolveToken(value);
    }
  }
}

export function createBrowserSolard(
  options: BrowserSolardOptions,
): BrowserSolard {
  return new BrowserSolard(options);
}
