import { sol } from "../../../../src/index.js";
import {
  boolValue,
  numberValue,
  optionalString,
  readJson,
  requireString,
  withSowl,
} from "../../../../src/web/http.js";

export async function POST(request: Request): Promise<Response> {
  const body = await readJson(request);
  return withSowl(request, async (sowl) => {
    const token = requireString(body, "token");
    const wallet = requireString(body, "wallet");
    const amountSol = requireString(body, "amountSol");
    const slippageBps = numberValue(body, "slippageBps", 1500);
    const via = optionalString(body, "sender") ?? "rpc";
    const live = boolValue(body, "live", false);

    if (!live) {
      const plan = await sowl
        .tx(wallet)
        .buy(token, sol(amountSol), { slippageBps })
        .build();
      const simulation = await sowl.simulatePlan(plan);
      return { mode: "dry-run", simulation };
    }

    const receipt = await sowl.buy(token, wallet, sol(amountSol), {
      slippageBps,
      via,
      skipSimulation: boolValue(body, "skipSimulation", false),
      skipPreflight: boolValue(body, "skipPreflight", true),
    });
    return { mode: "live", receipt };
  });
}
