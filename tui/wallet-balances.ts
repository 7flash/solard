/** Every token balance of a wallet in two RPC calls (one per token program) instead of one call per coin per bot:
 * 80 bots reading their own balance every 60s were ~100 calls/min, the largest RPC user. Bots read their balance
 * from this snapshot (refreshed every 20s) and still force a direct read of their coin right before a trade. */
import { PublicKey, type Connection } from "@solana/web3.js";

const PROGRAMS = [new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")];
type Snapshot = { at: number; byMint: Map<string, bigint> };

export class WalletBalances {
  private readonly snaps = new Map<string, Snapshot>();
  private readonly pending = new Map<string, Promise<void>>();
  constructor(private readonly o: { connection: Connection; log: (t: string) => void; refreshMs?: number; wrap?: <T>(t: () => Promise<T>) => Promise<T> }) {}

  /** Balance of mint in owner's wallet from a snapshot at most maxAgeMs old (refreshed on demand), or null. */
  async balance(owner: string, mint: string, maxAgeMs = this.o.refreshMs ?? 20_000): Promise<{ raw: bigint; at: number } | null> {
    let s = this.snaps.get(owner);
    if (!s || Date.now() - s.at > maxAgeMs) { await this.refresh(owner); s = this.snaps.get(owner); }
    return s ? { raw: s.byMint.get(mint) ?? 0n, at: s.at } : null;
  }
  /** After a trade the snapshot is stale for that wallet. */
  invalidate(owner: string) { this.snaps.delete(owner); }

  private refresh(owner: string): Promise<void> {
    let p = this.pending.get(owner);
    if (!p) {
      p = (this.o.wrap ?? (t => t()))(async () => {
        const byMint = new Map<string, bigint>(), at = Date.now();
        for (const programId of PROGRAMS) {
          const r = await this.o.connection.getTokenAccountsByOwner(new PublicKey(owner), { programId }, "confirmed");
          for (const a of r.value) {
            const d = a.account.data; if (d.length < 72) continue;
            const mint = new PublicKey(d.subarray(0, 32)).toBase58(); // SPL account: mint at 0, amount at 64
            byMint.set(mint, (byMint.get(mint) ?? 0n) + d.readBigUInt64LE(64));
          }
        }
        this.snaps.set(owner, { at, byMint });
      }).catch(error => { this.o.log(`wallet balances ${owner.slice(0, 6)}: ${String(error instanceof Error ? error.message : error).slice(0, 100)}`); })
        .finally(() => { this.pending.delete(owner); });
      this.pending.set(owner, p);
    }
    return p;
  }
}
