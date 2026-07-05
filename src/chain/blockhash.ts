import type {
  BlockhashWithExpiryBlockHeight,
  Connection,
} from "@solana/web3.js";
export class BlockhashCache {
  private current?: { value: BlockhashWithExpiryBlockHeight; at: number };
  constructor(private readonly ttlMs = 1000) {}
  async get(connection: Connection): Promise<BlockhashWithExpiryBlockHeight> {
    if (this.current && Date.now() - this.current.at < this.ttlMs)
      return this.current.value;
    const value = await connection.getLatestBlockhash("confirmed");
    this.current = { value, at: Date.now() };
    return value;
  }
  invalidate(): void {
    this.current = undefined;
  }
}
