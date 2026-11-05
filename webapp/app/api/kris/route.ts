/** Kris's feed for the Kris view (?kris=1): what slrd-kris wrote, newest first. The terminal itself never reads this. */
import { readJson } from "../../lib/bridge.ts";
import { KRIS_WALLET, krisTotals } from "../../../../tui/kris-public.ts";

export async function GET() {
  return Response.json({ events: readJson<unknown[]>(".range-bots/kris-events.json") ?? [], ca: process.env.KRIS_CA ?? "", wallet: KRIS_WALLET, stats: krisTotals(process.cwd()) }, { headers: { "cache-control": "no-store" } });
}
