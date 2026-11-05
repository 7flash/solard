/** "Global fees paid" for a coin, like Axiom shows: network + priority fees and Jito tips of every
 * transaction that touched the mint, from `fromMs` (its launch) until now. One SQD portal query.
 * Tips to other senders (Nozomi, 0slot, ...) are not counted, so this reads slightly low. */
import bs58 from "bs58";

const PORTAL = "https://portal.sqd.dev/datasets/solana-mainnet";
const SYSTEM = "11111111111111111111111111111111";
const JITO_TIPS = new Set([
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5", "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY", "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh", "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL", "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
]);

type Ix = { transactionIndex: number; programId: string; accounts?: string[]; data?: string };
type Block = { header: { number: number }; transactions?: Array<{ transactionIndex: number; fee?: string | number }>; instructions?: Ix[] };

export type TokenFees = { feesSol: number; tipsSol: number; totalSol: number; transactions: number; fromSlot: number; toSlot: number };

/** Lamports of a System Program transfer (type 2) to a Jito tip account, else 0. */
function tipLamports(ix: Ix): number {
  if (ix.programId !== SYSTEM || !ix.data || !ix.accounts?.[1] || !JITO_TIPS.has(ix.accounts[1])) return 0;
  try {
    const b = bs58.decode(ix.data);
    if (b.length < 12 || b[0] !== 2 || b[1] !== 0 || b[2] !== 0 || b[3] !== 0) return 0;
    return Number(new DataView(b.buffer, b.byteOffset).getBigUint64(4, true));
  } catch { return 0; }
}

export async function globalFeesPaid(mint: string, fromMs: number, signal?: AbortSignal): Promise<TokenFees> {
  const head = await (await fetch(`${PORTAL}/head`, { signal })).json() as { number: number };
  // ~2.5 slots/s; start a little early so the launch transaction is included.
  const fromSlot = Math.max(0, head.number - Math.ceil((Date.now() - fromMs) / 400) - 300);
  let cursor = fromSlot, fees = 0, tips = 0, txs = 0;
  while (cursor <= head.number) {
    const toBlock = Math.min(head.number, cursor + 20_000); // ~2.2h per request keeps the portal happy
    let res: Response | null = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      res = await fetch(`${PORTAL}/stream`, {
      method: "POST", headers: { "content-type": "application/json" }, signal,
      body: JSON.stringify({
        type: "solana", fromBlock: cursor, toBlock,
        fields: { block: { number: true }, transaction: { transactionIndex: true, fee: true },
          instruction: { transactionIndex: true, programId: true, accounts: true, data: true } },
        instructions: [{ mentionsAccount: [mint], transaction: true, transactionInstructions: true }],
      }),
      });
      if (![429, 503, 529].includes(res.status)) break;
      const wait = Number(res.headers.get("retry-after")) * 1000 || 1_000 * 2 ** attempt;
      await res.body?.cancel(); await Bun.sleep(Math.min(wait, 20_000));
    }
    if (!res) break;
    if (res.status === 204) { cursor = toBlock + 1; continue; }
    if (!res.ok) throw new Error(`SQD fees query HTTP ${res.status}`);
    let last = cursor - 1;
    for (const line of (await res.text()).split("\n")) {
      if (!line.trim()) continue;
      const block = JSON.parse(line) as Block;
      last = Math.max(last, block.header.number);
      for (const tx of block.transactions ?? []) { fees += Number(tx.fee ?? 0); txs++; }
      for (const ix of block.instructions ?? []) tips += tipLamports(ix);
    }
    cursor = Math.max(last, cursor - 1) + 1;
    if (last < cursor - 1) cursor = toBlock + 1; // empty range
  }
  return { feesSol: fees / 1e9, tipsSol: tips / 1e9, totalSol: (fees + tips) / 1e9, transactions: txs, fromSlot, toSlot: head.number };
}
