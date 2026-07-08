import { PublicKey, SystemProgram } from "@solana/web3.js";
import { sol, HeliusSender, HttpRpcSender } from "../../../../src/index.js";
import {
  boolValue,
  numberValue,
  optionalString,
  readJson,
  requireString,
  withSowl,
} from "../../../../src/web/http.js";

function installWebTradeSenders(sowl: any): void {
  const rpcUrl =
    process.env.HELIUS_RPC_URL?.trim() || process.env.RPC_ENDPOINT?.trim();
  const senderUrl = process.env.HELIUS_SENDER_URL?.trim();
  if (senderUrl)
    sowl.registerSender(new HeliusSender(senderUrl, "helius-fast"));
  if (rpcUrl)
    sowl.registerSender(
      new HttpRpcSender("helius-rpc", rpcUrl, "HELIUS_RPC_URL/RPC_ENDPOINT"),
    );
}

function parseSolLamports(value: string | undefined, fallback: string): bigint {
  return sol(value && value.trim() ? value : fallback).raw;
}

function heliusTipAccount(): PublicKey {
  const value =
    process.env.HELIUS_TIP_ACCOUNT?.trim() ||
    process.env.SOLWAL_HELIUS_TIP_ACCOUNT?.trim() ||
    process.env.SOWL_HELIUS_TIP_ACCOUNT?.trim();
  if (!value)
    throw new Error(
      "HELIUS_TIP_ACCOUNT is required for helius-fast quick buys",
    );
  return new PublicKey(value);
}

export async function POST(request: Request): Promise<Response> {
  const body = await readJson(request);
  return withSowl(request, async (sowl) => {
    installWebTradeSenders(sowl);
    const token = requireString(body, "token");
    const wallet = requireString(body, "wallet");
    const amountSol = requireString(body, "amountSol");
    const slippageBps = numberValue(body, "slippageBps", 1500);
    const via = optionalString(body, "sender") ?? "rpc";
    const live = boolValue(body, "live", false);
    const skipSimulation = boolValue(body, "skipSimulation", false);
    const skipPreflight = boolValue(body, "skipPreflight", true);
    const priorityMicroLamports = numberValue(
      body,
      "priorityMicroLamports",
      via === "helius-fast" ? 1_500_000 : 0,
    );
    const cuLimit = numberValue(body, "cuLimit", 600_000);

    const tx = sowl
      .tx(wallet)
      .priorityFee({ cuLimit, microLamports: priorityMicroLamports })
      .buy(token, sol(amountSol), { slippageBps });
    if (via === "helius-fast") {
      const payer = sowl.signer(wallet).publicKey;
      const tipLamports = parseSolLamports(
        optionalString(body, "tipSol"),
        "0.001",
      );
      tx.add(
        SystemProgram.transfer({
          fromPubkey: payer,
          toPubkey: heliusTipAccount(),
          lamports: Number(tipLamports),
        }),
        {
          kind: "sender-tip",
          recipient: heliusTipAccount(),
          meta: {
            lamports: tipLamports.toString(),
            sender: "helius-fast",
            source: "web-terminal-quick-buy",
          },
        },
      );
    }

    if (!live) {
      const plan = await tx.build();
      const simulation = await sowl.simulatePlan(plan);
      return { mode: "dry-run", simulation };
    }

    const receipt = await tx.send({
      via,
      kind: "web:terminal:quick-buy",
      skipSimulation,
      skipPreflight,
    });
    return { mode: "live", receipt };
  });
}
