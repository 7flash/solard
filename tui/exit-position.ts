/** Operator exit: sell 100% and close the token account in one transaction, after the engine(s) stopped.
 * With bid-ask steps one coin has several slice state files; all are checked and all are marked flat. */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Solard } from "../packages/sdk/src/client.ts";

type SellClient = Pick<Solard, "sell">;

export async function exitPosition(input: {
  client: SellClient; wallet: string; mint: string; statePath: string | string[];
  say: (text: string) => void; log?: (text: string) => void; slippageBps?: number;
}): Promise<"sold" | "flat" | "pending" | "unresolved" | "failed"> {
  const { client, wallet, mint, say } = input;
  const paths = (Array.isArray(input.statePath) ? input.statePath : [input.statePath]).filter(p => existsSync(p));
  const read = (path: string) => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } };
  const states = paths.map(path => ({ path, state: read(path) }));
  if (states.some(s => s.state?.pending)) { say("A transaction is still pending: NOT selling blind. Relaunch; it reconciles, then stop again."); return "pending"; }
  const holding = states.filter(s => s.state?.position);
  if (!holding.length) { say("Flat: nothing to sell."); return "flat"; }
  const cost = holding.reduce((sum, s) => sum + Number(s.state.position.costLamports) / 1e9, 0);
  for (let attempt = 1; attempt <= 3; attempt++) {
    say(`Selling 100% of the wallet's ${mint.slice(0, 6)} + closing token account, attempt ${attempt}…`);
    try {
      const result = await client.sell({ wallet, token: mint, amount: "all", closeTokenAccount: true, slippageBps: input.slippageBps ?? 500 });
      input.log?.(`exit sell result ${JSON.stringify(result, (_k, v) => typeof v === "bigint" ? v.toString() : v).slice(0, 2000)}`);
      if (result?.status === "confirmed") {
        const got = result.solPrincipalDeltaLamports != null ? Number(result.solPrincipalDeltaLamports) / 1e9 : null;
        say(`SOLD + closed.${got != null ? ` received ${got.toFixed(4)} SOL (cost ${cost.toFixed(4)}, pnl ${got - cost >= 0 ? "+" : ""}${(got - cost).toFixed(4)})` : ""} sig ${result.signature ?? "?"}`);
        for (const { path } of states) {
          const state = read(path); if (!state) continue;
          state.position = null; state.phase = "buy"; state.health = "OPERATOR_EXIT";
          state.entryPause = { reason: "OPERATOR_EXIT", at: new Date().toISOString(), signature: result.signature };
          writeFileSync(`${path}.tmp`, JSON.stringify(state, null, 2)); renameSync(`${path}.tmp`, path);
        }
        return "sold";
      }
      say(`Sell not confirmed: ${result?.status ?? "?"} ${result?.message ?? ""}`);
      if (result?.status === "unresolved") { say("Outcome unknown: NOT retrying (could double-sell). Check the wallet, then relaunch."); return "unresolved"; }
    } catch (error) { say(`Sell failed: ${error instanceof Error ? error.message : String(error)}`); }
  }
  say("Could not sell after 3 attempts. Position kept; relaunch the bot or sell manually.");
  return "failed";
}
