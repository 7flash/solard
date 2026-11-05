/** Real holders from the chain, for entry checks. Our trade stream cannot see tokens bought inside a launch transaction
 * (AJJjNs: 69.7% invisible) or moved by transfer, so the check that matters asks the chain directly: two or three RPC
 * reads, only when a bot is about to open. */
import { PublicKey, type Connection } from "@solana/web3.js";

export type TopHolder = { pct: number; owner: string; kind: "pool" | "wallet" | "lock" };
const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", PUMP_AMM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", SYSTEM = "11111111111111111111111111111111";
const SUPPLY = 1e9;

/** Who owns a token account decides what it is: the pump programs are the pool, a plain system account is a wallet that
 * can sell, and any other program holds tokens under its own rules (AJJjNs's 69.7% sits in such an account). */
export function holderKind(ownerProgram: string | null): TopHolder["kind"] {
  if (ownerProgram === PUMP || ownerProgram === PUMP_AMM) return "pool";
  return !ownerProgram || ownerProgram === SYSTEM ? "wallet" : "lock";
}

/** Reason to refuse an entry, or null. Only launch holders count: a big wallet that got its tokens at launch is a bundle,
 * one that built its position by trading later is just a large trader (PIKA's 20% holder is fine). `atLaunch` says which.
 * Locked supply and pools do not count; relay wallets are not real holders. */
export function holderVeto(holders: TopHolder[], ignore: Set<string> = new Set(), atLaunch: (owner: string) => boolean = () => true, maxOne = 15, maxTop = 40, maxAny = 40) {
  const free = holders.filter(h => h.kind === "wallet" && !ignore.has(h.owner)).sort((a, b) => b.pct - a.pct);
  // One wallet this big can end the coin however it got there (AXrB1a: 79% in one buy, 2.5 hours after launch).
  if (free[0] && free[0].pct > maxAny) return `one wallet ${free[0].owner.slice(0, 6)} holds ${free[0].pct.toFixed(0)}% of supply`;
  const wallets = free.filter(h => atLaunch(h.owner));
  const top = wallets[0], sum = wallets.reduce((a, h) => a + h.pct, 0);
  if (top && top.pct > maxOne) return `one wallet ${top.owner.slice(0, 6)} holds ${top.pct.toFixed(0)}% of supply`;
  if (sum > maxTop) return `top wallets hold ${sum.toFixed(0)}% of supply`;
  return null;
}

export async function topHolders(connection: Connection, mint: string): Promise<TopHolder[]> {
  const largest = (await connection.getTokenLargestAccounts(new PublicKey(mint))).value;
  const infos = await connection.getMultipleAccountsInfo(largest.map(a => a.address));
  const owners = infos.map(i => i && i.data.length >= 64 ? new PublicKey(i.data.subarray(32, 64)) : null);
  const known = owners.filter((o): o is PublicKey => !!o);
  const ownerInfos = await connection.getMultipleAccountsInfo(known);
  const programOf = new Map(known.map((o, i) => [o.toBase58(), ownerInfos[i]?.owner.toBase58() ?? null]));
  return largest.flatMap((a, i) => { const o = owners[i]?.toBase58(); return o ? [{ pct: Number(a.uiAmount ?? 0) / SUPPLY * 100, owner: o, kind: holderKind(programOf.get(o) ?? null) }] : []; });
}
