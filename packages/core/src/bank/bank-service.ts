import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import bs58 from "bs58";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createCloseAccountInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";

import { readMint } from "../chain/state.ts";
import type { TokenRef, WalletRef } from "../core/refs.ts";
import type { TokenRow } from "../db/schema.ts";
import type { Solard } from "../sdk/slrd.ts";
import { transferTokenIxs } from "../tx/spl.ts";
import type { SendReceipt, SenderId, SimulationResult } from "../tx/types.ts";

type StoredDepositWallet = {
  depositId: string;
  userId: string;
  label: string | null;
  address: string;
  secretKeyBase58: string;
  createdAtMs: number;
  updatedAtMs: number;
};

type DepositVault = {
  version: 1;
  wallets: StoredDepositWallet[];
};

type MintRuntime = {
  token: TokenRow;
  mint: PublicKey;
  tokenProgram: PublicKey;
  decimals: number;
};

export type BankSendStatus = "simulated" | "sent" | "confirmed" | "failed";

export class SolardBank {
  private readonly storePath: string;

  constructor(private readonly slrd: Solard) {
    this.storePath =
      process.env.SLRD_BANK_STORE_PATH?.trim() ||
      "./data/slrd-bank-deposits.json";
  }

  generateDepositWallet(args: { userId: string; label?: string }): {
    depositId: string;
    userId: string;
    label: string | null;
    address: string;
    alreadyExisted: boolean;
  } {
    const userId = args.userId.trim();
    if (!userId) throw new Error("generateDepositWallet requires userId");

    const vault = this.readVault();
    const existing = vault.wallets.find((row) => row.userId === userId);
    if (existing) {
      return {
        depositId: existing.depositId,
        userId: existing.userId,
        label: existing.label,
        address: existing.address,
        alreadyExisted: true,
      };
    }

    const keypair = Keypair.generate();
    const now = Date.now();
    const row: StoredDepositWallet = {
      depositId: `dep_${createHash("sha256").update(userId).digest("hex").slice(0, 20)}`,
      userId,
      label: args.label?.trim() || null,
      address: keypair.publicKey.toBase58(),
      secretKeyBase58: bs58.encode(keypair.secretKey),
      createdAtMs: now,
      updatedAtMs: now,
    };

    vault.wallets.push(row);
    this.writeVault(vault);

    return {
      depositId: row.depositId,
      userId: row.userId,
      label: row.label,
      address: row.address,
      alreadyExisted: false,
    };
  }

  async tokenBalance(args: {
    token: TokenRef;
    owner: WalletRef | string;
  }): Promise<{
    owner: string;
    mint: string;
    tokenAccount: string;
    amountRaw: bigint;
    amountUi: string;
    decimals: number;
  }> {
    const runtime = await this.tokenRuntime(args.token);
    const owner = this.resolveOwner(args.owner);
    const tokenAccount = getAssociatedTokenAddressSync(
      runtime.mint,
      owner,
      false,
      runtime.tokenProgram,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    let amountRaw = 0n;
    try {
      amountRaw = (
        await getAccount(
          this.slrd.connection(),
          tokenAccount,
          "confirmed",
          runtime.tokenProgram,
        )
      ).amount;
    } catch {
      amountRaw = 0n;
    }

    return {
      owner: owner.toBase58(),
      mint: runtime.mint.toBase58(),
      tokenAccount: tokenAccount.toBase58(),
      amountRaw,
      amountUi: formatRaw(amountRaw, runtime.decimals),
      decimals: runtime.decimals,
    };
  }

  async scanDeposits(args: {
    token: TokenRef;
    deposit: string;
    limit?: number;
    afterSignature?: string | null;
    commitment?: "confirmed" | "finalized";
  }): Promise<{
    deposit: string;
    depositAddress: string;
    tokenAccount: string;
    scanned: number;
    latestSignature: string | null;
    deposits: Array<{
      depositId: string;
      signature: string;
      slot: number;
      amountRaw: bigint;
      amountUi: string;
      confirmedAt: string | null;
    }>;
  }> {
    const runtime = await this.tokenRuntime(args.token);
    const depositAddress = this.resolveDepositAddress(args.deposit);
    const owner = new PublicKey(depositAddress);
    const tokenAccount = getAssociatedTokenAddressSync(
      runtime.mint,
      owner,
      false,
      runtime.tokenProgram,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    const account = await this.slrd
      .connection()
      .getAccountInfo(tokenAccount, args.commitment ?? "confirmed");
    if (!account) {
      return {
        deposit: args.deposit,
        depositAddress,
        tokenAccount: tokenAccount.toBase58(),
        scanned: 0,
        latestSignature: null,
        deposits: [],
      };
    }

    const signatures = await this.slrd
      .connection()
      .getSignaturesForAddress(
        tokenAccount,
        { limit: Math.max(1, Math.min(1000, args.limit ?? 50)) },
        args.commitment ?? "confirmed",
      );

    const deposits = [];
    for (const item of [...signatures].reverse()) {
      if (args.afterSignature && item.signature === args.afterSignature)
        continue;
      if (item.err) continue;

      const tx = await this.slrd
        .connection()
        .getParsedTransaction(item.signature, {
          commitment: args.commitment ?? "confirmed",
          maxSupportedTransactionVersion: 0,
        });
      if (!tx || tx.meta?.err) continue;

      const amountRaw = ownerDeltaForMint(
        tx,
        runtime.mint.toBase58(),
        owner.toBase58(),
      );
      if (amountRaw <= 0n) continue;

      deposits.push({
        depositId: `${item.signature}:${owner.toBase58()}`,
        signature: item.signature,
        slot: item.slot,
        amountRaw,
        amountUi: formatRaw(amountRaw, runtime.decimals),
        confirmedAt:
          item.blockTime == null
            ? null
            : new Date(item.blockTime * 1000).toISOString(),
      });
    }

    return {
      deposit: args.deposit,
      depositAddress,
      tokenAccount: tokenAccount.toBase58(),
      scanned: signatures.length,
      latestSignature: signatures[0]?.signature ?? null,
      deposits,
    };
  }

  async sendToken(args: {
    token: TokenRef;
    from: WalletRef | string;
    to: string | PublicKey;
    amountRaw: bigint;
    createRecipientAccount?: boolean;
    sender?: SenderId;
    live?: boolean;
    skipSimulation?: boolean;
    skipPreflight?: boolean;
  }): Promise<{
    from: string;
    to: string;
    mint: string;
    amountRaw: bigint;
    amountUi: string;
    dryRun: boolean;
    status: BankSendStatus;
    signature?: string;
    simulation?: SimulationResult;
    receipt?: SendReceipt;
  }> {
    if (args.amountRaw <= 0n)
      throw new Error("sendToken amountRaw must be > 0");
    const runtime = await this.tokenRuntime(args.token);
    const recipient =
      typeof args.to === "string" ? new PublicKey(args.to) : args.to;
    const from = this.slrd.signer(args.from);

    const tx = this.slrd
      .tx(args.from)
      .transferToken(runtime.token, recipient, args.amountRaw);

    if (!args.live) {
      const plan = await tx.build();
      const simulation = await this.slrd.simulatePlan(plan);
      return {
        from: from.publicKey.toBase58(),
        to: recipient.toBase58(),
        mint: runtime.mint.toBase58(),
        amountRaw: args.amountRaw,
        amountUi: formatRaw(args.amountRaw, runtime.decimals),
        dryRun: true,
        status: simulation.success ? "simulated" : "failed",
        simulation,
      };
    }

    const receipt = await tx.send({
      via: args.sender ?? "rpc",
      kind: "bank:send-token",
      skipSimulation: args.skipSimulation,
      skipPreflight: args.skipPreflight,
    });

    return {
      from: from.publicKey.toBase58(),
      to: recipient.toBase58(),
      mint: runtime.mint.toBase58(),
      amountRaw: args.amountRaw,
      amountUi: formatRaw(args.amountRaw, runtime.decimals),
      dryRun: false,
      status:
        receipt.status === "confirmed"
          ? "confirmed"
          : receipt.status === "failed"
            ? "failed"
            : "sent",
      signature: receipt.signature,
      receipt,
    };
  }

  async sweepDepositWallet(args: {
    token: TokenRef;
    deposit: string;
    to: WalletRef | string;
    closeEmptyTokenAccount?: boolean;
    sender?: SenderId;
    live?: boolean;
    skipSimulation?: boolean;
    skipPreflight?: boolean;
  }): Promise<{
    deposit: string;
    depositAddress: string;
    to: string;
    mint: string;
    amountRaw: bigint;
    amountUi: string;
    dryRun: boolean;
    skipped?: "zero-balance";
    status: "skipped" | BankSendStatus;
    signature?: string;
    simulation?: SimulationResult;
    receipt?: SendReceipt;
  }> {
    const runtime = await this.tokenRuntime(args.token);
    const deposit = this.resolveDepositWallet(args.deposit);
    const owner = Keypair.fromSecretKey(bs58.decode(deposit.secretKeyBase58));
    const payer = this.slrd.signer(args.to);

    const source = getAssociatedTokenAddressSync(
      runtime.mint,
      owner.publicKey,
      false,
      runtime.tokenProgram,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    let amountRaw = 0n;
    try {
      amountRaw = (
        await getAccount(
          this.slrd.connection(),
          source,
          "confirmed",
          runtime.tokenProgram,
        )
      ).amount;
    } catch {
      amountRaw = 0n;
    }

    if (amountRaw <= 0n) {
      return {
        deposit: args.deposit,
        depositAddress: owner.publicKey.toBase58(),
        to: payer.publicKey.toBase58(),
        mint: runtime.mint.toBase58(),
        amountRaw: 0n,
        amountUi: formatRaw(0n, runtime.decimals),
        dryRun: !args.live,
        skipped: "zero-balance",
        status: "skipped",
      };
    }

    const transfer = transferTokenIxs({
      payer: payer.publicKey,
      owner: owner.publicKey,
      recipient: payer.publicKey,
      mint: runtime.mint,
      amountRaw,
      decimals: runtime.decimals,
      tokenProgram: runtime.tokenProgram,
    });

    const instructions = [...transfer.instructions];
    if (args.closeEmptyTokenAccount) {
      instructions.push(
        createCloseAccountInstruction(
          source,
          payer.publicKey,
          owner.publicKey,
          [],
          runtime.tokenProgram,
        ),
      );
    }

    const builder = this.slrd
      .transaction(args.to)
      .addMany(instructions, {
        kind: "bank:sweep-deposit",
        mint: runtime.mint,
        recipient: payer.publicKey,
        meta: {
          deposit: args.deposit,
          depositAddress: owner.publicKey.toBase58(),
          amountRaw: amountRaw.toString(),
          closeEmptyTokenAccount: args.closeEmptyTokenAccount === true,
        },
      })
      .withSigner(owner)
      .track({ address: transfer.source, kind: "token", mint: runtime.mint })
      .track({
        address: transfer.destination,
        kind: "token",
        mint: runtime.mint,
      });

    if (!args.live) {
      const plan = await builder.build();
      const simulation = await this.slrd.simulatePlan(plan);
      return {
        deposit: args.deposit,
        depositAddress: owner.publicKey.toBase58(),
        to: payer.publicKey.toBase58(),
        mint: runtime.mint.toBase58(),
        amountRaw,
        amountUi: formatRaw(amountRaw, runtime.decimals),
        dryRun: true,
        status: simulation.success ? "simulated" : "failed",
        simulation,
      };
    }

    const receipt = await builder.send({
      via: args.sender ?? "rpc",
      kind: "bank:sweep-deposit",
      skipSimulation: args.skipSimulation,
      skipPreflight: args.skipPreflight,
    });

    return {
      deposit: args.deposit,
      depositAddress: owner.publicKey.toBase58(),
      to: payer.publicKey.toBase58(),
      mint: runtime.mint.toBase58(),
      amountRaw,
      amountUi: formatRaw(amountRaw, runtime.decimals),
      dryRun: false,
      status:
        receipt.status === "confirmed"
          ? "confirmed"
          : receipt.status === "failed"
            ? "failed"
            : "sent",
      signature: receipt.signature,
      receipt,
    };
  }

  async checkTransaction(
    signature: string,
    args: { searchTransactionHistory?: boolean } = {},
  ): Promise<{
    signature: string;
    found: boolean;
    status: "unknown" | "processed" | "confirmed" | "finalized" | "failed";
    confirmationStatus: string | null;
    confirmations: number | null;
    slot: number | null;
    err: unknown;
  }> {
    const [status] = (
      await this.slrd.connection().getSignatureStatuses([signature], {
        searchTransactionHistory: args.searchTransactionHistory ?? true,
      })
    ).value;

    const confirmationStatus = status?.confirmationStatus ?? null;
    const failed = status?.err != null;
    return {
      signature,
      found: Boolean(status),
      status: !status
        ? "unknown"
        : failed
          ? "failed"
          : confirmationStatus === "finalized"
            ? "finalized"
            : confirmationStatus === "confirmed"
              ? "confirmed"
              : "processed",
      confirmationStatus,
      confirmations: status?.confirmations ?? null,
      slot: status?.slot ?? null,
      err: status?.err ?? null,
    };
  }

  private async tokenRuntime(ref: TokenRef): Promise<MintRuntime> {
    const token = this.slrd.resolveToken(ref);
    const mint = new PublicKey(token.mint);
    const cachedDecimals =
      typeof token.decimals === "number" ? token.decimals : null;
    const cachedProgram =
      typeof token.baseTokenProgram === "string" &&
      token.baseTokenProgram.length > 0
        ? new PublicKey(token.baseTokenProgram)
        : null;

    if (cachedDecimals != null && cachedProgram) {
      return {
        token,
        mint,
        decimals: cachedDecimals,
        tokenProgram: cachedProgram,
      };
    }

    const mintState = await readMint(
      this.slrd.connection(),
      mint,
      this.slrd.cache,
    );
    return {
      token,
      mint,
      decimals: mintState.decimals,
      tokenProgram: mintState.tokenProgram,
    };
  }

  private resolveOwner(ref: WalletRef | string): PublicKey {
    if (ref instanceof PublicKey) return ref;
    if (ref instanceof Keypair) return ref.publicKey;
    if (typeof ref !== "string") return new PublicKey(ref.address);

    try {
      return this.slrd.resolveWallet(ref).address;
    } catch {
      return new PublicKey(ref);
    }
  }

  private resolveDepositAddress(deposit: string): string {
    const fromVault = this.findDeposit(deposit);
    if (fromVault) return fromVault.address;
    return new PublicKey(deposit).toBase58();
  }

  private resolveDepositWallet(deposit: string): StoredDepositWallet {
    const found = this.findDeposit(deposit);
    if (!found) {
      throw new Error(
        `Unknown deposit wallet: ${deposit}. Use bank.generateDepositWallet() first or import the key through bank store.`,
      );
    }
    return found;
  }

  private findDeposit(value: string): StoredDepositWallet | undefined {
    const clean = value.trim();
    return this.readVault().wallets.find(
      (row) =>
        row.depositId === clean ||
        row.userId === clean ||
        row.address === clean ||
        row.label === clean,
    );
  }

  private readVault(): DepositVault {
    if (!existsSync(this.storePath)) return { version: 1, wallets: [] };
    const parsed = JSON.parse(
      readFileSync(this.storePath, "utf8"),
    ) as DepositVault;
    return { version: 1, wallets: parsed.wallets ?? [] };
  }

  private writeVault(vault: DepositVault): void {
    mkdirSync(dirname(this.storePath), { recursive: true });
    writeFileSync(
      this.storePath,
      `${JSON.stringify(vault, null, 2)}\n`,
      "utf8",
    );
  }
}

function formatRaw(raw: bigint, decimals: number): string {
  const negative = raw < 0n;
  const value = negative ? -raw : raw;
  const unit = 10n ** BigInt(decimals);
  const whole = value / unit;
  const frac = value % unit;
  const fracText =
    decimals === 0
      ? ""
      : frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole.toString()}${fracText ? `.${fracText}` : ""}`;
}

function ownerDeltaForMint(
  tx: import("@solana/web3.js").ParsedTransactionWithMeta,
  mint: string,
  owner: string,
): bigint {
  const pre = ownerBalances(tx.meta?.preTokenBalances, mint);
  const post = ownerBalances(tx.meta?.postTokenBalances, mint);
  return (post.get(owner) ?? 0n) - (pre.get(owner) ?? 0n);
}

function ownerBalances(
  balances:
    | readonly {
        mint: string;
        owner?: string;
        uiTokenAmount: { amount: string };
      }[]
    | null
    | undefined,
  mint: string,
): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const balance of balances ?? []) {
    if (balance.mint !== mint || !balance.owner) continue;
    out.set(
      balance.owner,
      (out.get(balance.owner) ?? 0n) + BigInt(balance.uiTokenAmount.amount),
    );
  }
  return out;
}
