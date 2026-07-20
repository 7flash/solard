import { PublicKey, SystemProgram } from "@solana/web3.js";
import { sol } from "../../core/amounts.ts";
import type { SenderId } from "../../tx/types.ts";
import { addTokenToTradedGroup } from "../../pump/services/pump-live-store.ts";
import type { SolardActionContext } from "./context.ts";
import { assertLiveAllowed } from "./context.ts";
import { measureSolard, summarizeForMeasure } from "../api-response.ts";

export type TradeTargetInput = {
  wallet?: string | null;
  wallets?: string[] | string | null;
  group?: string | null;
};

export type NormalizedTradeTargets = {
  mode: "wallet" | "wallets" | "group";
  refs: string[];
  group?: string;
};

export type TradeTokenMeta = {
  name?: string | null;
  symbol?: string | null;
  creator?: string | null;
  description?: string | null;
  website?: string | null;
  twitter?: string | null;
  telegram?: string | null;
  uri?: string | null;
  image?: string | null;
  signature?: string | null;
  marketCapSol?: number | string | null;
  isMayhemMode?: boolean | null;
  quoteAsset?: string | null;
  quoteMint?: string | null;
};

function csv(value: string[] | string | null | undefined): string[] {
  if (Array.isArray(value))
    return value.map((item) => item.trim()).filter(Boolean);
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function normalizeTradeTargets(
  ctx: SolardActionContext,
  input: TradeTargetInput,
): NormalizedTradeTargets {
  const wallet = input.wallet?.trim();
  const wallets = csv(input.wallets);
  const group = input.group?.trim();
  const selected = [Boolean(wallet), wallets.length > 0, Boolean(group)].filter(
    Boolean,
  ).length;
  if (selected !== 1) {
    throw new Error("Supply exactly one of wallet, wallets, or group.");
  }
  if (wallet) return { mode: "wallet", refs: [wallet] };
  if (wallets.length > 0) return { mode: "wallets", refs: wallets };
  return {
    mode: "group",
    refs: ctx.slrd.groupWallets(group!).map((ref) => String(ref)),
    group,
  };
}

function parseLamports(
  value: string | null | undefined,
  fallbackSol: string,
): bigint {
  return sol(value && value.trim() ? value : fallbackSol).raw;
}

function heliusTipAccount(): PublicKey {
  const value =
    process.env.HELIUS_TIP_ACCOUNT?.trim() ||
    process.env.SOLWAL_HELIUS_TIP_ACCOUNT?.trim() ||
    process.env.SLRD_HELIUS_TIP_ACCOUNT?.trim();
  if (!value)
    throw new Error(
      "HELIUS_TIP_ACCOUNT is required for helius-fast live trades.",
    );
  return new PublicKey(value);
}

function maybeRecordTradedToken(args: {
  token: string;
  tokenMeta?: TradeTokenMeta | null;
  signature?: string | null;
  source: string;
}) {
  const meta = args.tokenMeta ?? {};
  return addTokenToTradedGroup({
    mint: args.token,
    name: meta.name ?? null,
    symbol: meta.symbol ?? null,
    creator: meta.creator ?? null,
    uri: meta.uri ?? null,
    image: meta.image ?? null,
    signature: meta.signature ?? args.signature ?? null,
    marketCapSol:
      meta.marketCapSol == null || meta.marketCapSol === ""
        ? null
        : Number(meta.marketCapSol),
    isMayhemMode:
      typeof meta.isMayhemMode === "boolean" ? meta.isMayhemMode : null,
    quoteAsset: meta.quoteAsset ?? null,
    quoteMint: meta.quoteMint ?? null,
    source: args.source,
  });
}

async function buyTokenActionInner(
  ctx: SolardActionContext,
  input: {
    token: string;
    amountSol: string;
    target: TradeTargetInput;
    slippageBps?: number;
    sender?: string | null;
    live?: boolean;
    skipSimulation?: boolean;
    skipPreflight?: boolean;
    priorityMicroLamports?: number;
    cuLimit?: number;
    tipSol?: string | null;
    tokenMeta?: TradeTokenMeta | null;
  },
): Promise<Record<string, unknown>> {
  const token = input.token?.trim();
  const amountSol = input.amountSol?.trim();
  if (!token) throw new Error("token is required");
  if (!amountSol) throw new Error("amountSol is required");

  const targets = normalizeTradeTargets(ctx, input.target);
  const via = (input.sender?.trim() || "rpc") as SenderId;
  const options = {
    slippageBps: input.slippageBps ?? 1500,
    via,
    skipSimulation: Boolean(input.skipSimulation),
    skipPreflight: Boolean(input.skipPreflight || input.skipSimulation),
  };

  if (!input.live) {
    const plans =
      targets.refs.length === 1
        ? [
            await ctx.slrd
              .tx(targets.refs[0]!)
              .buy(token, sol(amountSol), options)
              .build(),
          ]
        : await ctx.slrd
            .composeMany(targets.refs)
            .buy(token, sol(amountSol), options)
            .build();
    const results = await Promise.all(
      plans.map((plan) => ctx.slrd.simulatePlan(plan)),
    );
    return { mode: "simulation", action: "buy", target: targets, results };
  }

  assertLiveAllowed(ctx, "buy");

  if (via === "helius-fast" && targets.refs.length === 1) {
    const payer = ctx.slrd.signer(targets.refs[0]!).publicKey;
    const tipAccount = heliusTipAccount();
    const tipLamports = parseLamports(input.tipSol, "0.001");
    const tx = ctx.slrd
      .tx(targets.refs[0]!)
      .priorityFee({
        cuLimit: input.cuLimit ?? 600_000,
        microLamports: input.priorityMicroLamports ?? 1_500_000,
      })
      .buy(token, sol(amountSol), options)
      .add(
        SystemProgram.transfer({
          fromPubkey: payer,
          toPubkey: tipAccount,
          lamports: Number(tipLamports),
        }),
        {
          kind: "sender-tip",
          recipient: tipAccount,
          meta: {
            lamports: tipLamports.toString(),
            sender: "helius-fast",
            source: "solard-buy",
          },
        },
      );
    const receipt = await tx.send({
      via,
      kind: "buy",
      skipSimulation: options.skipSimulation,
      skipPreflight: options.skipPreflight,
    });
    const watchGroup =
      receipt.status !== "failed"
        ? maybeRecordTradedToken({
            token,
            tokenMeta: input.tokenMeta,
            signature: receipt.signature,
            source: "trade-buy",
          })
        : null;
    return {
      mode: "live",
      action: "buy",
      target: targets,
      receipt,
      watchGroup,
    };
  }

  const receipt =
    targets.refs.length === 1
      ? await ctx.slrd.buy(token, targets.refs[0]!, sol(amountSol), options)
      : await ctx.slrd.buyMany(token, targets.refs, sol(amountSol), options);
  const status = Array.isArray(receipt)
    ? receipt.every((item) => item.status !== "failed")
    : receipt.status !== "failed";
  const signature = Array.isArray(receipt)
    ? receipt.find((item) => item.signature)?.signature
    : receipt.signature;
  const watchGroup = status
    ? maybeRecordTradedToken({
        token,
        tokenMeta: input.tokenMeta,
        signature,
        source: "trade-buy",
      })
    : null;
  return { mode: "live", action: "buy", target: targets, receipt, watchGroup };
}

async function sellTokenActionInner(
  ctx: SolardActionContext,
  input: {
    token: string;
    target: TradeTargetInput;
    bps?: number;
    slippageBps?: number;
    sender?: string | null;
    live?: boolean;
    skipSimulation?: boolean;
    skipPreflight?: boolean;
  },
): Promise<Record<string, unknown>> {
  const token = input.token?.trim();
  if (!token) throw new Error("token is required");
  const targets = normalizeTradeTargets(ctx, input.target);
  const options = {
    bps: input.bps ?? 10000,
    slippageBps: input.slippageBps ?? 1500,
    via: (input.sender?.trim() || "rpc") as SenderId,
    skipSimulation: Boolean(input.skipSimulation),
    skipPreflight: Boolean(input.skipPreflight || input.skipSimulation),
  };

  if (!input.live) {
    const plans =
      targets.refs.length === 1
        ? [await ctx.slrd.tx(targets.refs[0]!).sell(token, options).build()]
        : await ctx.slrd.composeMany(targets.refs).sell(token, options).build();
    const results = await Promise.all(
      plans.map((plan) => ctx.slrd.simulatePlan(plan)),
    );
    return { mode: "simulation", action: "sell", target: targets, results };
  }

  assertLiveAllowed(ctx, "sell");
  const receipt =
    targets.refs.length === 1
      ? await ctx.slrd.sell(token, targets.refs[0]!, options)
      : await ctx.slrd.sellMany(token, targets.refs, options);
  return { mode: "live", action: "sell", target: targets, receipt };
}

export async function buyTokenAction(
  ctx: SolardActionContext,
  input: Parameters<typeof buyTokenActionInner>[1],
): Promise<Record<string, unknown>> {
  const measured = await measureSolard(
    `solard:action:trade:buy:${input.live ? "live" : "simulation"}`,
    "buyTokenAction",
    async () => await buyTokenActionInner(ctx, input),
    {
      summarize: summarizeForMeasure,
      meta: {
        token: input.token,
        live: Boolean(input.live),
        sender: input.sender ?? "rpc",
      },
      onError: (error) => {
        throw error;
      },
    },
  );
  return measured.value;
}

export async function sellTokenAction(
  ctx: SolardActionContext,
  input: Parameters<typeof sellTokenActionInner>[1],
): Promise<Record<string, unknown>> {
  const measured = await measureSolard(
    `solard:action:trade:sell:${input.live ? "live" : "simulation"}`,
    "sellTokenAction",
    async () => await sellTokenActionInner(ctx, input),
    {
      summarize: summarizeForMeasure,
      meta: {
        token: input.token,
        live: Boolean(input.live),
        sender: input.sender ?? "rpc",
      },
      onError: (error) => {
        throw error;
      },
    },
  );
  return measured.value;
}
