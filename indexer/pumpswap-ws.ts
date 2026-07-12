import type { PumpSwapConfig } from "./pumpswap-config.js";
import { fetchTransaction } from "./pumpswap-rpc.js";
import type { PumpSwapCounters } from "./pumpswap-types.js";

type AnyRow = Record<string, any>;

export async function runPumpSwapWsSession(
  config: PumpSwapConfig,
  counters: PumpSwapCounters,
  signal: AbortSignal,
  onTransaction: (payload: AnyRow) => Promise<void>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(config.wsUrl);

    let closed = false;
    let subscriptionId: number | null = null;

    const requestId = Date.now();

    const finish = (error?: unknown) => {
      if (closed) {
        return;
      }

      closed = true;

      signal.removeEventListener("abort", abort);

      try {
        socket.close();
      } catch {}

      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    const abort = () => finish();

    signal.addEventListener("abort", abort, {
      once: true,
    });

    socket.onopen = () => {
      counters.sessions++;

      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",

          id: requestId,

          method: "transactionSubscribe",

          params: [
            {
              vote: false,

              failed: false,

              accountInclude: [config.programId],
            },
            {
              commitment: config.commitment,

              encoding: "jsonParsed",

              transactionDetails: "full",

              showRewards: false,

              maxSupportedTransactionVersion: 0,
            },
          ],
        }),
      );
    };

    let queue: Promise<void> = Promise.resolve();

    const enqueue = (work: () => Promise<void>) => {
      queue = queue
        .catch(() => undefined)
        .then(work)
        .catch((error) => {
          counters.errors++;

          console.error(
            "[solard:pumpswap] transaction processing failed",
            error,
          );
        });
    };

    socket.onmessage = (event) => {
      counters.messages++;

      let message: AnyRow;

      try {
        message = JSON.parse(String(event.data));
      } catch {
        counters.errors++;
        return;
      }

      if (message.id === requestId && message.error) {
        /**
         * transactionSubscribe is Helius-specific. Fall back to the standard
         * logs stream and fetch full transactions over RPC.
         */
        counters.mode = "logsSubscribe";

        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",

            id: requestId + 1,

            method: "logsSubscribe",

            params: [
              {
                mentions: [config.programId],
              },
              {
                commitment: config.commitment,
              },
            ],
          }),
        );

        return;
      }

      if (message.id === requestId || message.id === requestId + 1) {
        subscriptionId = Number(message.result) || null;

        return;
      }

      if (message.method === "transactionNotification") {
        counters.transactionNotifications++;

        enqueue(() => onTransaction(message));

        return;
      }

      if (message.method === "logsNotification") {
        counters.logNotifications++;

        const signature = String(
          message.params?.result?.value?.signature ?? "",
        );

        const slot = Number(message.params?.result?.context?.slot ?? 0);

        if (!signature) {
          return;
        }

        enqueue(async () => {
          const transaction = await fetchTransaction(config, signature);

          if (!transaction) {
            counters.skipped++;
            return;
          }

          counters.fetchedTransactions++;

          await onTransaction({
            params: {
              result: {
                signature,
                slot,

                transaction: {
                  transaction: transaction.transaction,

                  meta: transaction.meta,
                },

                blockTime: transaction.blockTime,

                commitment: config.commitment,
              },
            },
          });
        });
      }
    };

    socket.onerror = (event) => {
      finish(new Error(`PumpSwap websocket error: ${String(event)}`));
    };

    socket.onclose = (event) => {
      if (signal.aborted) {
        finish();
        return;
      }

      finish(
        new Error(
          `PumpSwap websocket closed code=${event.code} reason=${event.reason || "none"} subscription=${subscriptionId ?? "none"}`,
        ),
      );
    };
  });
}
