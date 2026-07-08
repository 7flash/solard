import { SystemProgram } from "@solana/web3.js";
import { sol } from "../../../../src/index.js";
import {
  boolValue,
  numberValue,
  optionalString,
  readJson,
  requireString,
  withSowl,
} from "../../../../src/web/http.js";
import { addTokenToTradedGroup } from "../../../../src/web/token-watch-store.js";
import {
  assertLiveTradeAllowed,
  heliusTipAccount,
  installWebTradeSenders,
  parseSolLamports,
} from "../../../../src/web/live-safety.js";

export async function POST(request: Request): Promise<Response> {
  const body = await readJson(request);
  return withSowl(request, async (sowl) => {
    installWebTradeSenders(sowl);
    const token = requireString(body, "token");
    const wallet = requireString(body, "wallet");
    const tokenMeta =
      body.tokenMeta && typeof body.tokenMeta === "object"
        ? (body.tokenMeta as Record<string, unknown>)
        : {};
    const amountSol = requireString(body, "amountSol");
    const slippageBps = numberValue(body, "slippageBps", 1500);
    const via = optionalString(body, "sender") ?? "rpc";
    const live = boolValue(body, "live", false);
    if (live) assertLiveTradeAllowed("web quick buy");
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
    let watchGroup = null;
    if (receipt.status !== "failed") {
      watchGroup = addTokenToTradedGroup({
        mint: token,
        name: typeof tokenMeta.name === "string" ? tokenMeta.name : null,
        symbol: typeof tokenMeta.symbol === "string" ? tokenMeta.symbol : null,
        creator:
          typeof tokenMeta.creator === "string" ? tokenMeta.creator : null,
        description:
          typeof tokenMeta.description === "string"
            ? tokenMeta.description
            : null,
        website:
          typeof tokenMeta.website === "string" ? tokenMeta.website : null,
        twitter:
          typeof tokenMeta.twitter === "string" ? tokenMeta.twitter : null,
        telegram:
          typeof tokenMeta.telegram === "string" ? tokenMeta.telegram : null,
        uri: typeof tokenMeta.uri === "string" ? tokenMeta.uri : null,
        image: typeof tokenMeta.image === "string" ? tokenMeta.image : null,
        signature:
          typeof tokenMeta.signature === "string"
            ? tokenMeta.signature
            : (receipt.signature ?? null),
        marketCapSol:
          tokenMeta.marketCapSol == null || tokenMeta.marketCapSol === ""
            ? null
            : Number(tokenMeta.marketCapSol),
        isMayhemMode:
          typeof tokenMeta.isMayhemMode === "boolean"
            ? tokenMeta.isMayhemMode
            : null,
        quoteAsset:
          typeof tokenMeta.quoteAsset === "string"
            ? tokenMeta.quoteAsset
            : null,
        quoteMint:
          typeof tokenMeta.quoteMint === "string" ? tokenMeta.quoteMint : null,
        source: "web-terminal-buy",
      });
    }
    return { mode: "live", receipt, watchGroup };
  });
}
