import type { Connection } from "@solana/web3.js";
import type { SendReceipt } from "./types.js";
export async function confirmSignature(
  connection: Connection,
  signature: string,
  sender: string,
  timeoutMs = 30_000,
): Promise<SendReceipt> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const status = (
      await connection.getSignatureStatuses([signature], {
        searchTransactionHistory: true,
      })
    ).value[0];
    if (status?.err)
      return {
        signature,
        slot: status.slot ?? null,
        sender,
        status: "failed",
        error: JSON.stringify(status.err),
      };
    if (
      status?.confirmationStatus === "confirmed" ||
      status?.confirmationStatus === "finalized"
    ) {
      return {
        signature,
        slot: status.slot ?? null,
        sender,
        status: "confirmed",
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return { signature, slot: null, sender, status: "broadcast" };
}
