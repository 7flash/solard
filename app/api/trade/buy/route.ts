import {
  boolValue,
  numberValue,
  optionalString,
  readJson,
  requireString,
  withSowl,
} from "../../../../src/web/http.js";
import {
  buyTokenAction,
  createSolardActionContext,
  type TradeTokenMeta,
} from "../../../../src/solard/actions/index.js";

export async function POST(request: Request): Promise<Response> {
  const body = await readJson(request);
  return withSowl(request, async (sowl) => {
    const ctx = createSolardActionContext({ sowl });
    const tokenMeta =
      body.tokenMeta && typeof body.tokenMeta === "object"
        ? (body.tokenMeta as TradeTokenMeta)
        : null;
    return await buyTokenAction(ctx, {
      token: requireString(body, "token"),
      amountSol: requireString(body, "amountSol"),
      target: { wallet: requireString(body, "wallet") },
      slippageBps: numberValue(body, "slippageBps", 1500),
      sender: optionalString(body, "sender") ?? "rpc",
      live: boolValue(body, "live", false),
      skipSimulation: boolValue(body, "skipSimulation", false),
      skipPreflight: boolValue(body, "skipPreflight", true),
      priorityMicroLamports: numberValue(
        body,
        "priorityMicroLamports",
        optionalString(body, "sender") === "helius-fast" ? 1_500_000 : 0,
      ),
      cuLimit: numberValue(body, "cuLimit", 600_000),
      tipSol: optionalString(body, "tipSol"),
      tokenMeta,
    });
  });
}
