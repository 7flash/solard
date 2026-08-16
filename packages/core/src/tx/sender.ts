import type { Connection, VersionedTransaction } from "@solana/web3.js";
import type { SenderId, SendOptions } from "./types.ts";

export type BundleSubmission = { submissionId: string; signatures: string[] };

export interface SolardSender {
  readonly id: SenderId;
  send(args: {
    connection: Connection;
    transaction: VersionedTransaction;
    options?: SendOptions;
  }): Promise<string>;
}
export interface SolardBundleSender extends SolardSender {
  sendBundle(args: {
    connection: Connection;
    transactions: VersionedTransaction[];
  }): Promise<BundleSubmission>;
}
export function isBundleSender(
  sender: SolardSender,
): sender is SolardBundleSender {
  return (
    "sendBundle" in sender &&
    typeof (sender as SolardBundleSender).sendBundle === "function"
  );
}
export class SenderRegistry {
  private readonly values = new Map<string, SolardSender>();
  register(sender: SolardSender): this {
    this.values.set(sender.id, sender);
    return this;
  }
  resolve(id: SenderId): SolardSender {
    const value = this.values.get(id);
    if (!value) throw new Error(`Sender not registered: ${id}`);
    return value;
  }
  list(): string[] {
    return [...this.values.keys()];
  }
}
