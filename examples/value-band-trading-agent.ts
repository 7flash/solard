#!/usr/bin/env bun
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  NATIVE_MINT,
} from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import {
  configure,
  createMeasure,
  safeStringify,
  type MeasureLogEvent,
} from "measure-fn";
import {
  createTraderSolard,
  executeJupiterSwap,
  quoteJupiterSwap,
} from "@solard/core";

type Flags = Map<string, string>;
const SOL = NATIVE_MINT.toBase58();
const m = createMeasure("value-band-agent");

function parseArgs(argv: string[]): Flags {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i]!;
    if (!item.startsWith("--")) continue;
    const [key, inline] = item.slice(2).split("=", 2);
    if (inline != null) out.set(key!, inline);
    else if (argv[i + 1] && !argv[i + 1]!.startsWith("--"))
      out.set(key!, argv[++i]!);
    else out.set(key!, "true");
  }
  return out;
}
function flag(flags: Flags, key: string): string | undefined {
  const v = flags.get(key);
  return v && v !== "true" ? v : undefined;
}
function required(flags: Flags, key: string): string {
  const v = flag(flags, key);
  if (!v) throw new Error(`Missing --${key} <value>`);
  return v;
}
function num(flags: Flags, key: string, fallback: number): number {
  const raw = flag(flags, key);
  if (raw == null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Invalid --${key}: ${raw}`);
  return value;
}
function liveGate(): boolean {
  return [
    process.env.SOLARD_ENABLE_LIVE_TRADES,
    process.env.SLRD_ENABLE_LIVE_TRADES,
    process.env.SOLWAL_ENABLE_LIVE_TRADES,
  ].some((v) => v === "1" || v === "true");
}
function short(v: string): string {
  return v.length <= 18 ? v : `${v.slice(0, 8)}…${v.slice(-6)}`;
}
function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));
}

async function tokenRuntime(
  slrd: ReturnType<typeof createTraderSolard>,
  mint: PublicKey,
) {
  const info = await slrd.connection().getAccountInfo(mint, "confirmed");
  if (!info) throw new Error(`Mint not found: ${mint.toBase58()}`);
  const mintInfo = await getMint(
    slrd.connection(),
    mint,
    "confirmed",
    info.owner,
  );
  return { tokenProgram: info.owner, decimals: mintInfo.decimals };
}

async function tokenBalanceRaw(args: {
  slrd: ReturnType<typeof createTraderSolard>;
  owner: PublicKey;
  mint: PublicKey;
  tokenProgram: PublicKey;
}): Promise<bigint> {
  const ata = getAssociatedTokenAddressSync(
    args.mint,
    args.owner,
    false,
    args.tokenProgram,
  );
  try {
    return (
      await getAccount(
        args.slrd.connection(),
        ata,
        "confirmed",
        args.tokenProgram,
      )
    ).amount;
  } catch {
    return 0n;
  }
}

async function quoteLiquidation(mint: string, raw: bigint) {
  if (raw <= 0n)
    return {
      outRaw: 0n,
      sol: 0,
      feeBps: null as number | null,
      router: null as string | null,
    };
  const q = await quoteJupiterSwap({
    inputMint: mint,
    outputMint: SOL,
    amountRaw: raw,
  });
  return {
    outRaw: q.outAmountRaw,
    sol: Number(q.outAmountRaw) / 1e9,
    feeBps: q.feeBps,
    router: q.router,
  };
}

async function quoteBuyInputForTokenTarget(args: {
  mint: string;
  targetTokenRaw: bigint;
  maxSolRaw: bigint;
}): Promise<{ inputRaw: bigint; expectedOutRaw: bigint }> {
  if (args.targetTokenRaw <= 0n) return { inputRaw: 0n, expectedOutRaw: 0n };
  let lo = 1n;
  let hi = args.maxSolRaw;
  let best: { inputRaw: bigint; expectedOutRaw: bigint } | null = null;
  for (let i = 0; i < 9 && lo <= hi; i += 1) {
    const mid = (lo + hi) / 2n;
    const q = await quoteJupiterSwap({
      inputMint: SOL,
      outputMint: args.mint,
      amountRaw: mid,
    });
    if (q.outAmountRaw >= args.targetTokenRaw) {
      best = { inputRaw: mid, expectedOutRaw: q.outAmountRaw };
      hi = mid - 1n;
    } else {
      lo = mid + 1n;
    }
  }
  if (best) return best;
  const q = await quoteJupiterSwap({
    inputMint: SOL,
    outputMint: args.mint,
    amountRaw: args.maxSolRaw,
  });
  return { inputRaw: args.maxSolRaw, expectedOutRaw: q.outAmountRaw };
}

type Dashboard = {
  now: string;
  token: string;
  wallet: string;
  live: boolean;
  baseSol: number;
  lowerSol: number;
  upperSol: number;
  tokenRaw: bigint;
  tokenUi: number;
  liquidationSol: number;
  walletSol: number;
  freeSol: number;
  router: string | null;
  action: string;
  detail: string;
  lastSignature: string | null;
};

function draw(d: Dashboard, logPath: string, adjustStep: number) {
  process.stdout.write("\x1b[2J\x1b[H");
  console.log("SOLARD VALUE-BAND AGENT");
  console.log(`Token:   ${d.token}`);
  console.log(`Wallet:  ${d.wallet}`);
  console.log(`Mode:    ${d.live ? "LIVE" : "DRY"}`);
  console.log("");
  console.log(
    `Target:  ${d.baseSol.toFixed(4)} SOL   band=${d.lowerSol.toFixed(4)}..${d.upperSol.toFixed(4)} SOL`,
  );
  console.log(
    `Token:   ${d.tokenUi.toLocaleString(undefined, { maximumFractionDigits: 6 })}`,
  );
  console.log(`Exit value now: ${d.liquidationSol.toFixed(6)} SOL`);
  console.log(
    `Wallet SOL:     ${d.walletSol.toFixed(6)} SOL   free=${d.freeSol.toFixed(6)}`,
  );
  console.log(`Route:   ${d.router ?? "-"}`);
  console.log(`Action:  ${d.action} ${d.detail}`);
  console.log(`Tx:      ${d.lastSignature ?? "-"}`);
  console.log(`Updated: ${d.now}`);
  console.log("");
  console.log(
    `Controls: [+] target +${adjustStep} SOL   [-] target -${adjustStep} SOL   [s] scale toward target now   [q] quit`,
  );
  console.log(`Measure log: ${logPath}`);
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.has("help")) {
    console.log(
      "Usage: slrd run examples/value-band-trading-agent.ts --token <mint> --wallet <wallet> [--base-sol 0.1] [--lower-multiple 0.5] [--upper-multiple 1.8] [--sell-fraction 0.5] [--reserve-sol 0.02] [--poll-ms 5000] [--scale-now] [--dashboard] [--live]",
    );
    return;
  }
  const token = new PublicKey(required(flags, "token"));
  const walletRef = required(flags, "wallet");
  let baseSol = Math.max(0.000001, num(flags, "base-sol", 0.1));
  const lowerMultiple = Math.max(0, num(flags, "lower-multiple", 0.5));
  const upperMultiple = Math.max(
    lowerMultiple,
    num(flags, "upper-multiple", 1.8),
  );
  const sellFraction = Math.min(
    1,
    Math.max(0.0001, num(flags, "sell-fraction", 0.5)),
  );
  const reserveSol = Math.max(0, num(flags, "reserve-sol", 0.02));
  const pollMs = Math.max(1000, Math.trunc(num(flags, "poll-ms", 5000)));
  const live = flags.has("live");
  const dashboard = flags.has("dashboard") || Boolean(process.stdout.isTTY);
  const adjustStep = Math.max(
    0.000001,
    num(flags, "adjust-step-sol", Math.max(0.01, baseSol * 0.1)),
  );
  let scaleNow = flags.has("scale-now");
  let quit = false;
  let lastSignature: string | null = null;
  if (live && !liveGate())
    throw new Error(
      "Live trading requires --live and SOLARD_ENABLE_LIVE_TRADES=1",
    );

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = resolve(
    flag(flags, "log") ?? `logs/value-band-${token.toBase58()}-${stamp}.jsonl`,
  );
  mkdirSync(dirname(logPath), { recursive: true });
  configure({
    logger(event: MeasureLogEvent, next: () => void) {
      appendFileSync(
        logPath,
        `${safeStringify({ at: new Date().toISOString(), event })}\n`,
      );
      if (!dashboard) next();
    },
  });

  const slrd = createTraderSolard();
  const signer = slrd.signer(walletRef);
  const owner = signer.publicKey;
  const runtime = await tokenRuntime(slrd, token);

  if (process.stdin.isTTY) {
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (key: string) => {
      if (key === "q" || key === "\u0003") quit = true;
      else if (key === "+" || key === "=") baseSol += adjustStep;
      else if (key === "-")
        baseSol = Math.max(adjustStep, baseSol - adjustStep);
      else if (key.toLowerCase() === "s") scaleNow = true;
    });
  }

  await m("policy", async () => ({
    token: token.toBase58(),
    wallet: owner.toBase58(),
    live,
    baseSol,
    lowerMultiple,
    upperMultiple,
    sellFraction,
    reserveSol,
    pollMs,
    logPath,
  }));

  while (!quit) {
    try {
      await m("cycle", async () => {
        const tokenRaw = await tokenBalanceRaw({
          slrd,
          owner,
          mint: token,
          tokenProgram: runtime.tokenProgram,
        });
        const walletLamports = BigInt(
          await slrd.connection().getBalance(owner, "confirmed"),
        );
        const walletSol = Number(walletLamports) / 1e9;
        const freeLamports =
          walletLamports > BigInt(Math.ceil(reserveSol * 1e9))
            ? walletLamports - BigInt(Math.ceil(reserveSol * 1e9))
            : 0n;
        const liquidation = await quoteLiquidation(token.toBase58(), tokenRaw);
        const lowerSol = baseSol * lowerMultiple;
        const upperSol = baseSol * upperMultiple;
        let action = "HOLD";
        let detail = "inside band";

        if (tokenRaw === 0n) {
          action = "BUY";
          detail = `bootstrap ${baseSol.toFixed(4)} SOL`;
          if (live && freeLamports > 0n) {
            const inputRaw = BigInt(
              Math.min(Number(freeLamports), Math.floor(baseSol * 1e9)),
            );
            if (inputRaw > 0n) {
              const result = await executeJupiterSwap({
                inputMint: SOL,
                outputMint: token.toBase58(),
                amountRaw: inputRaw,
                signer,
              });
              lastSignature = result.signature ?? null;
            }
          }
        } else if (liquidation.sol >= upperSol) {
          const sellRaw = BigInt(
            Math.max(1, Math.floor(Number(tokenRaw) * sellFraction)),
          );
          action = "SELL";
          detail = `${(sellFraction * 100).toFixed(1)}% because ${liquidation.sol.toFixed(4)} >= ${upperSol.toFixed(4)} SOL`;
          if (live) {
            const result = await executeJupiterSwap({
              inputMint: token.toBase58(),
              outputMint: SOL,
              amountRaw: sellRaw,
              signer,
            });
            lastSignature = result.signature ?? null;
          }
        } else if (liquidation.sol < lowerSol || scaleNow) {
          const targetRaw = scaleNow
            ? tokenRaw === 0n
              ? 0n
              : BigInt(
                  Math.max(
                    0,
                    Math.floor(
                      Number(tokenRaw) *
                        Math.max(
                          0,
                          baseSol / Math.max(liquidation.sol, 1e-12) - 1,
                        ),
                    ),
                  ),
                )
            : tokenRaw;
          if (targetRaw > 0n && freeLamports > 0n) {
            const q = await quoteBuyInputForTokenTarget({
              mint: token.toBase58(),
              targetTokenRaw: targetRaw,
              maxSolRaw: freeLamports,
            });
            action = "BUY";
            detail = `${Number(q.inputRaw) / 1e9} SOL to add ~${Number(targetRaw) / 10 ** runtime.decimals} tokens${scaleNow ? " (scale-now)" : " (match current units)"}`;
            if (live && q.inputRaw > 0n) {
              const result = await executeJupiterSwap({
                inputMint: SOL,
                outputMint: token.toBase58(),
                amountRaw: q.inputRaw,
                signer,
              });
              lastSignature = result.signature ?? null;
            }
          } else {
            action = "HOLD";
            detail =
              "below target but no free SOL or no additional token target";
          }
          scaleNow = false;
        }

        const d: Dashboard = {
          now: new Date().toISOString(),
          token: token.toBase58(),
          wallet: owner.toBase58(),
          live,
          baseSol,
          lowerSol,
          upperSol,
          tokenRaw,
          tokenUi: Number(tokenRaw) / 10 ** runtime.decimals,
          liquidationSol: liquidation.sol,
          walletSol,
          freeSol: Number(freeLamports) / 1e9,
          router: liquidation.router,
          action,
          detail,
          lastSignature,
        };
        if (dashboard) draw(d, logPath, adjustStep);
        return { ...d, tokenRaw: tokenRaw.toString() };
      });
    } catch (error) {
      await m(
        { start: () => "recoverable cycle error", end: (x) => x },
        async () => ({
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      if (flags.has("fail-fast")) throw error;
    }
    if (!flags.has("loop")) break;
    await sleep(pollMs);
  }
  process.stdin.setRawMode?.(false);
  process.stdin.pause();
}

main().catch((error) => {
  process.stdin.setRawMode?.(false);
  console.error(error);
  process.exitCode = 1;
});
