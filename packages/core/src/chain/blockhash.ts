import type {
  BlockhashWithExpiryBlockHeight,
  Connection,
} from "@solana/web3.js";

export class BlockhashCache {
  private current?: {
    connection: Connection;
    value: BlockhashWithExpiryBlockHeight;
    at: number;
  };
  private generation = 0;
  private readonly pending = new Map<
    Connection,
    Promise<BlockhashWithExpiryBlockHeight>
  >();
  constructor(private readonly ttlMs = 1000) {}

  async get(connection: Connection): Promise<BlockhashWithExpiryBlockHeight> {
    if (
      this.current?.connection === connection &&
      Date.now() - this.current.at < this.ttlMs
    )
      return this.current.value;
    return this.refresh(connection);
  }

  private refresh(
    connection: Connection,
  ): Promise<BlockhashWithExpiryBlockHeight> {
    const existing = this.pending.get(connection);
    if (existing) return existing;
    const generation = this.generation;
    const request = Promise.resolve()
      .then(() => connection.getLatestBlockhash("confirmed"))
      .then((value) => {
        if (this.generation === generation)
          this.current = { connection, value, at: Date.now() };
        return value;
      })
      .finally(() => {
        if (this.pending.get(connection) === request)
          this.pending.delete(connection);
      });
    this.pending.set(connection, request);
    return request;
  }

  /** Opt-in warming; background errors leave foreground callers free to retry. */
  start(
    connection: Connection,
    options: { intervalMs?: number } = {},
  ): { stop(): void } {
    const intervalMs = options.intervalMs ?? 1000;
    if (!Number.isFinite(intervalMs) || intervalMs < 1)
      throw new Error("Blockhash refresh interval must be positive");
    const warm = () => {
      void this.refresh(connection).catch(() => {});
    };
    warm();
    const timer = setInterval(warm, intervalMs);
    timer.unref?.();
    return { stop: () => clearInterval(timer) };
  }

  invalidate(): void {
    this.generation++;
    this.current = undefined;
    // Old callers still receive their requested value, but an old request cannot
    // populate this generation or prevent a fresh request from starting.
    this.pending.clear();
  }
}
