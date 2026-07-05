import type { Connection, VersionedTransaction } from "@solana/web3.js";
import type { SenderId, SendOptions } from "./types.js";

export type BundleSubmission = { submissionId: string; signatures: string[] };

export interface SowlSender {
  readonly id: SenderId;
  send(args: { connection: Connection; transaction: VersionedTransaction; options?: SendOptions }): Promise<string>;
}
export interface SowlBundleSender extends SowlSender {
  sendBundle(args: { connection: Connection; transactions: VersionedTransaction[] }): Promise<BundleSubmission>;
}
export function isBundleSender(sender: SowlSender): sender is SowlBundleSender {
  return "sendBundle" in sender && typeof (sender as SowlBundleSender).sendBundle === "function";
}
export class SenderRegistry {
  private readonly values = new Map<string, SowlSender>();
  register(sender: SowlSender): this { this.values.set(sender.id, sender); return this; }
  resolve(id: SenderId): SowlSender {
    const value = this.values.get(id);
    if (!value) throw new Error(`Sender not registered: ${id}`);
    return value;
  }
  list(): string[] { return [...this.values.keys()]; }
}
