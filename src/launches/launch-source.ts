import type { Commitment, Connection, PublicKey } from "@solana/web3.js";
import { UnknownLaunchSourceError } from "../core/errors.js";
import type { TokenRow } from "../db/schema.js";

export type LaunchFilter = {
  mint?: string | PublicKey;
  name?: string;
  symbol?: string;
  creator?: string | PublicKey;
  quoteMint?: string | PublicKey;
};

export type DiscoveredLaunch = {
  source: string;
  signature: string;
  slot: number | null;
  mint: PublicKey;
  name: string | null;
  symbol: string | null;
  creator: PublicKey | null;
  token: Partial<TokenRow> & { mint: string };
  metadata?: Record<string, unknown>;
};

export type WaitForLaunchArgs = {
  filter: LaunchFilter;
  timeoutMs?: number;
  commitment?: Commitment;
  signal?: AbortSignal;
};

export interface LaunchSourcePlugin {
  readonly id: string;
  waitForLaunch(connection: Connection, args: WaitForLaunchArgs): Promise<DiscoveredLaunch>;
}

/** A registry for token-deployment feeds; separate from execution venues. */
export class LaunchSourceRegistry {
  private readonly sources = new Map<string, LaunchSourcePlugin>();

  register(source: LaunchSourcePlugin): this {
    this.sources.set(source.id, source);
    return this;
  }

  list(): readonly string[] { return [...this.sources.keys()]; }

  resolve(id: string): LaunchSourcePlugin {
    const source = this.sources.get(id);
    if (!source) {
      throw new UnknownLaunchSourceError(id);
    }
    return source;
  }

  async wait(connection: Connection, sourceId: string, args: WaitForLaunchArgs): Promise<DiscoveredLaunch> {
    return await this.resolve(sourceId).waitForLaunch(connection, args);
  }
}
