/** The selected coin: every wallet, live trades, ★ tags (proxied from the bridge's /api/coin-wallets). */
import { bridge } from "../../lib/bridge.ts";

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams, mint = q.get("mint") ?? "", watch = q.get("watch") === "0" ? "&watch=0" : "";
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return Response.json({ error: "mint" }, { status: 400 });
  return Response.json(await bridge(`/api/coin-wallets?mint=${mint}${watch}`), { headers: { "cache-control": "no-store" } });
}
