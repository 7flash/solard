import type { Connection } from "@solana/web3.js";

/** Only healthy, post-finalized-expiry absence authorizes a replacement. */
export async function inspectExpiredSubmission(
  connection: Pick<
    Connection,
    "getBlockHeight" | "getSignatureStatuses" | "getTransaction"
  >,
  signature: string,
  lastValidBlockHeight: number,
): Promise<"expired-unobserved" | "observed" | "unknown"> {
  try {
    const height = await connection.getBlockHeight("finalized");
    if (height <= lastValidBlockHeight) return "unknown";
    const status = (
      await connection.getSignatureStatuses([signature], {
        searchTransactionHistory: true,
      })
    ).value[0];
    // Even a processed status is evidence of execution: do not replace it.
    if (status) return "observed";
    const transaction = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 1,
    });
    return transaction ? "observed" : "expired-unobserved";
  } catch {
    return "unknown";
  }
}
