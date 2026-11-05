/** Worker thread: builds the follow list off the daemon's event loop by walking traderStats through its indexes, one wallet
 * at a time. Loading the table instead took 12-30 GB. */
import { Database } from "bun:sqlite";
import { followStream } from "./smart-entry.ts";
declare const self: Worker;
self.onmessage = () => {
  try {
    const db = new Database(process.env.SLRD_DB_PATH!, { readonly: true }), prices = new Map<string, number>();
    let mint = "", at = 0, price: number | null = null;
    const close = () => { if (mint && price != null) prices.set(mint, price); };
    for (const r of db.query("SELECT mint, lastPriceSol, lastAtMs FROM traderStats WHERE lastPriceSol IS NOT NULL ORDER BY mint").iterate() as Iterable<{ mint: string; lastPriceSol: number; lastAtMs: number }>) {
      if (r.mint !== mint) { close(); mint = r.mint; at = 0; price = null; }
      if (at < r.lastAtMs) { at = r.lastAtMs; price = r.lastPriceSol; }
    }
    close();
    const earliest = (db.query("SELECT MIN(firstAtMs) AS m FROM traderStats WHERE firstAtMs > 0").get() as { m: number | null }).m ?? Date.now();
    const { list, relays } = followStream({ prices, earliest }, db.query("SELECT * FROM traderStats ORDER BY trader").iterate() as never);
    db.close(); postMessage({ ok: true, list: [...list.values()], relays: [...relays] });
  } catch (error) { postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
};
