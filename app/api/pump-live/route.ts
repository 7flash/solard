import {
  assertWebAuth,
  errorResponse,
  jsonResponse,
  readJson,
} from "../../../src/web/http.js";
import {
  addTokenToWatchGroup,
  createTokenWatchGroup,
  listPumpLiveState,
  normalizePumpNewToken,
  recordPumpTrade,
  removeTokenFromWatchGroup,
} from "../../../src/web/pump-live-store.js";

const DEFAULT_PUMP_FEED_WS_URL = "wss://pumpportal.fun/api/data";

type Raw = Record<string, unknown>;

function sse(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
  );
}

function watchedMints(): string[] {
  return listPumpLiveState().watchedMints;
}

function subscribeWatched(ws: WebSocket): void {
  const keys = watchedMints();
  if (keys.length > 0)
    ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys }));
}

export function GET(request: Request): Response {
  try {
    assertWebAuth(request);
    const url = new URL(request.url);
    if (url.searchParams.get("stream") !== "1") {
      return jsonResponse({ ok: true, value: listPumpLiveState() });
    }

    const wsUrl =
      process.env.SOLWAL_PUMP_FEED_WS_URL?.trim() ||
      process.env.PUMPPORTAL_WS_URL?.trim() ||
      DEFAULT_PUMP_FEED_WS_URL;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        let seq = 0;
        let ws: WebSocket | null = null;
        let subscribed = new Set<string>();
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
          clearInterval(watchSync);
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
        const watchSync = setInterval(() => {
          if (!ws || ws.readyState !== WebSocket.OPEN) return;
          const keys = watchedMints().filter((mint) => !subscribed.has(mint));
          if (keys.length > 0) {
            ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys }));
            for (const key of keys) subscribed.add(key);
            send("status", {
              status: "subscribed-token-trades",
              keys,
              at: new Date().toISOString(),
            });
          }
        }, 2_000);
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
          subscribeWatched(ws!);
          subscribed = new Set(watchedMints());
        });
        ws.addEventListener("message", (message) => {
          try {
            const text =
              typeof message.data === "string"
                ? message.data
                : String(message.data);
            const parsed = JSON.parse(text) as Raw;
            const txType =
              typeof parsed.txType === "string"
                ? parsed.txType
                : typeof parsed.type === "string"
                  ? parsed.type
                  : "";
            const isNew =
              txType === "create" || parsed.name != null || parsed.uri != null;
            if (isNew && parsed.mint) {
              const token = normalizePumpNewToken(parsed, ++seq);
              if (token) send("token", token);
              return;
            }
            if (parsed.mint) {
              const token = recordPumpTrade(parsed);
              if (token) send("trade", token);
            }
          } catch (error) {
            send("warning", {
              error: error instanceof Error ? error.message : String(error),
              at: new Date().toISOString(),
            });
          }
        });
        ws.addEventListener("error", () =>
          send("status", { status: "error", at: new Date().toISOString() }),
        );
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

export async function POST(request: Request): Promise<Response> {
  try {
    assertWebAuth(request);
    const body = await readJson(request);
    const action = String(body.action ?? "");
    if (action === "create-group")
      return jsonResponse({
        ok: true,
        value: createTokenWatchGroup(String(body.name ?? "")),
      });
    if (action === "add-token")
      return jsonResponse({
        ok: true,
        value: addTokenToWatchGroup({
          groupId: String(body.groupId ?? "main"),
          ...body.token,
        }),
      });
    if (action === "remove-token")
      return jsonResponse({
        ok: true,
        value: removeTokenFromWatchGroup(
          String(body.groupId ?? ""),
          String(body.mint ?? ""),
        ),
      });
    throw new Error(`Unknown pump-live action: ${action || "(empty)"}`);
  } catch (error) {
    return errorResponse(
      error,
      typeof (error as { status?: unknown }).status === "number"
        ? (error as { status: number }).status
        : 500,
    );
  }
}
