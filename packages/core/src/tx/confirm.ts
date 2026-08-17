import type { Connection } from "@solana/web3.js";
import type { SendReceipt } from "./types.ts";
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
      // Signature status does not contain the charged fee. Fetch the confirmed
      // transaction metadata so receipts can report the authoritative on-chain
      // fee rather than an estimate.
      let meta:
        | { fee: number; computeUnitsConsumed?: number | bigint | null }
        | null
        | undefined;
      for (let attempt = 0; attempt < 5; attempt++) {
        const transaction = await connection.getTransaction(signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
        meta = transaction?.meta;
        if (meta) break;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }

      const computeUnitsConsumed =
        meta?.computeUnitsConsumed == null
          ? undefined
          : Number(meta.computeUnitsConsumed);

      return {
        signature,
        slot: status.slot ?? null,
        sender,
        status: "confirmed",
        feeLamports: meta?.fee,
        computeUnitsConsumed,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return { signature, slot: null, sender, status: "broadcast" };
}
