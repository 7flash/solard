/** Worker thread for the bridge: scores every wallet by walking traderStats through its indexes, one coin and one wallet
 * at a time. Loading the table instead took 14 GB. Only wallets with 2+ coins are sent back (one-coin wallets have no
 * profile worth showing). */
import { Database } from "bun:sqlite";
import { scoreStream, type StatRow } from "./wallet-scores.ts";
declare const self: Worker;
const COLS = "trader, mint, buys, sells, solIn, solOut, tokensBought, tokensSold, lastPriceSol, entryCapUsd, exitCapUsd, firstAtMs, lastAtMs";
self.onmessage = () => {
  try {
    const db = new Database(process.env.SLRD_DB_PATH!, { readonly: true });
    const scores = scoreStream(db.query(`SELECT ${COLS} FROM traderStats ORDER BY mint`).iterate() as Iterable<StatRow>,
      db.query(`SELECT ${COLS} FROM traderStats ORDER BY trader`).iterate() as Iterable<StatRow>, s => s.coins >= 2);
    db.close(); postMessage({ ok: true, scores });
  } catch (error) { postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
};
