import type { Connection, SignatureStatus } from "@solana/web3.js";
import { createSolardMeasure } from "../core/log.ts";
import { measured } from "../core/measured.ts";
import type { SendReceipt } from "./types.ts";

const m = createSolardMeasure("tx:confirm");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function receiptFromStatus(
  signature: string,
  sender: string,
  status: SignatureStatus,
): SendReceipt | null {
  if (status.err) {
    return {
      signature,
      slot: status.slot ?? null,
      sender,
      status: "failed",
      error: JSON.stringify(status.err),
    };
  }
  if (
    status.confirmationStatus === "confirmed" ||
    status.confirmationStatus === "finalized"
  ) {
    return {
      signature,
      slot: status.slot ?? null,
      sender,
      status: "confirmed",
    };
  }
  return null;
}

async function withTransactionMeta(
  connection: Connection,
  receipt: SendReceipt,
): Promise<SendReceipt> {
  if (receipt.status !== "confirmed") return receipt;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const transaction = await connection.getTransaction(receipt.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 1,
    });
    const meta = transaction?.meta;
    if (meta) {
      return {
        ...receipt,
        feeLamports: meta.fee,
        computeUnitsConsumed:
          meta.computeUnitsConsumed == null
            ? undefined
            : Number(meta.computeUnitsConsumed),
      };
    }
    if (attempt < 2) await sleep(250);
  }
  return receipt;
}

export async function confirmSignature(
  connection: Connection,
  signature: string,
  sender: string,
  timeoutMs = 30_000,
): Promise<SendReceipt> {
  let polls = 0;
  let source = "timeout";
  const startedAt = Date.now();

  return await measured(
    m,
    "signature",
    async () => {
      let websocketReceipt: SendReceipt | null = null;
      let listenerId: number | null = null;
      let wake: (() => void) | null = null;

      try {
        listenerId = connection.onSignature(
          signature,
          (result, context) => {
            websocketReceipt = result.err
              ? {
                  signature,
                  slot: context.slot ?? null,
                  sender,
                  status: "failed",
                  error: JSON.stringify(result.err),
                }
              : {
                  signature,
                  slot: context.slot ?? null,
                  sender,
                  status: "confirmed",
                };
            wake?.();
          },
          "confirmed",
        );
      } catch {}

      try {
        while (Date.now() - startedAt < timeoutMs) {
          if (websocketReceipt) {
            source = "websocket";
            return await withTransactionMeta(connection, websocketReceipt);
          }

          polls += 1;
          const status = (
            await connection.getSignatureStatuses([signature], {
              searchTransactionHistory: false,
            })
          ).value[0];
          if (status) {
            const receipt = receiptFromStatus(signature, sender, status);
            if (receipt) {
              source = "status";
              return await withTransactionMeta(connection, receipt);
            }
          }

          const remaining = timeoutMs - (Date.now() - startedAt);
          if (remaining <= 0) break;
          await new Promise<void>((resolve) => {
            let settled = false;
            const finish = () => {
              if (settled) return;
              settled = true;
              wake = null;
              clearTimeout(timer);
              resolve();
            };
            const timer = setTimeout(finish, Math.min(2_500, remaining));
            wake = finish;
            if (websocketReceipt) finish();
          });
        }

        polls += 1;
        const finalStatus = (
          await connection.getSignatureStatuses([signature], {
            searchTransactionHistory: true,
          })
        ).value[0];
        if (finalStatus) {
          const receipt = receiptFromStatus(signature, sender, finalStatus);
          if (receipt) {
            source = "history";
            return await withTransactionMeta(connection, receipt);
          }
        }
        return { signature, slot: null, sender, status: "submitted" };
      } finally {
        wake = null;
        if (listenerId != null) {
          await connection
            .removeSignatureListener(listenerId)
            .catch(() => undefined);
        }
      }
    },
    (receipt) => ({
      signature: receipt.signature,
      sender: receipt.sender,
      status: receipt.status,
      slot: receipt.slot,
      source,
      polls,
      elapsedMs: Date.now() - startedAt,
    }),
  );
}
