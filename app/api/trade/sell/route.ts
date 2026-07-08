import {
  boolValue,
  numberValue,
  optionalString,
  readJson,
  requireString,
  withSowl,
} from "../../../../src/web/http.js";
import {
  createSolardActionContext,
  sellTokenAction,
} from "../../../../src/solard/actions/index.js";

export async function POST(request: Request): Promise<Response> {
  const body = await readJson(request);
  return withSowl(request, async (sowl) => {
    const ctx = createSolardActionContext({ sowl });
    return await sellTokenAction(ctx, {
      token: requireString(body, "token"),
      target: { wallet: requireString(body, "wallet") },
      bps: numberValue(body, "bps", 10000),
      slippageBps: numberValue(body, "slippageBps", 1500),
      sender: optionalString(body, "sender") ?? "rpc",
      live: boolValue(body, "live", false),
      skipSimulation: boolValue(body, "skipSimulation", false),
      skipPreflight: boolValue(body, "skipPreflight", true),
    });
  });
}
