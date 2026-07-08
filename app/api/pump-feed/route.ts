import { assertWebAuth, errorResponse } from "../../../src/web/http.js";

const DEFAULT_PUMP_FEED_WS_URL = "wss://pumpportal.fun/api/data";

type PumpFeedRawEvent = Record<string, unknown>;

function sse(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
  );
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberField(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeNewToken(
  raw: PumpFeedRawEvent,
  seq: number,
): Record<string, unknown> {
  return {
    seq,
    receivedAt: new Date().toISOString(),
    source: "pumpportal",
    eventType: stringField(raw.txType) ?? stringField(raw.type) ?? "new-token",
    mint: stringField(raw.mint),
    name: stringField(raw.name),
    symbol: stringField(raw.symbol),
    uri: stringField(raw.uri),
    creator:
      stringField(raw.traderPublicKey) ??
      stringField(raw.creator) ??
      stringField(raw.user),
    signature: stringField(raw.signature) ?? stringField(raw.txSignature),
    initialBuy: numberField(raw.initialBuy),
    solAmount: numberField(raw.solAmount),
    marketCapSol: numberField(raw.marketCapSol),
    raw,
  };
}

export async function GET(request: Request): Promise<Response> {
  try {
    assertWebAuth(request);
    const wsUrl =
      process.env.SOLWAL_PUMP_FEED_WS_URL?.trim() ||
      process.env.PUMPPORTAL_WS_URL?.trim() ||
      DEFAULT_PUMP_FEED_WS_URL;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        let seq = 0;
        let ws: WebSocket | null = null;

        const send = (event: string, data: unknown) => {
          if (closed) return;
          try {
            controller.enqueue(sse(event, data));
          } catch {
            closed = true;
          }
        };
        const close = () => {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          try {
            ws?.close();
          } catch {}
          try {
            controller.close();
          } catch {}
        };

        const heartbeat = setInterval(
          () => send("ping", { at: new Date().toISOString() }),
          15_000,
        );
        request.signal.addEventListener("abort", close, { once: true });

        send("status", {
          status: "connecting",
          wsUrl,
          at: new Date().toISOString(),
        });
        ws = new WebSocket(wsUrl);

        ws.addEventListener("open", () => {
          send("status", {
            status: "connected",
            wsUrl,
            at: new Date().toISOString(),
          });
          ws?.send(JSON.stringify({ method: "subscribeNewToken" }));
        });

        ws.addEventListener("message", (message) => {
          try {
            const text =
              typeof message.data === "string"
                ? message.data
                : String(message.data);
            const parsed = JSON.parse(text) as PumpFeedRawEvent;
            send("token", normalizeNewToken(parsed, ++seq));
          } catch (error) {
            send("warning", {
              error: error instanceof Error ? error.message : String(error),
              at: new Date().toISOString(),
            });
          }
        });

        ws.addEventListener("error", () => {
          send("status", { status: "error", at: new Date().toISOString() });
        });

        ws.addEventListener("close", (event) => {
          send("status", {
            status: "closed",
            code: event.code,
            reason: event.reason || null,
            at: new Date().toISOString(),
          });
          close();
        });
      },
      cancel() {},
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      },
    });
  } catch (error) {
    return errorResponse(
      error,
      typeof (error as { status?: unknown }).status === "number"
        ? (error as { status: number }).status
        : 500,
    );
  }
}
