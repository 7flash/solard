export type PriceFeedVenue =
  "pump" | "pumpswap" | "raydium-launchlab" | "rpc-fallback";

export type PriceFeedLaunch = {
  type: "launch";
  atMs: number;
  signature: string | null;
  slot: number | null;
  mint: string;
  venue: "pump" | "raydium-launchlab";
  decimals: number;
  supplyUi: number;
  quoteMint: string | null;
  pool: string | null;
  name: string | null;
  symbol: string | null;
  isMayhemMode: boolean | null;
};

export type PriceFeedPrice = {
  type: "price";
  atMs: number;
  signature: string | null;
  slot: number | null;
  mint: string;
  venue: PriceFeedVenue;
  priceSol: number | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  source: string;
};

export type PriceFeedStatus = {
  type: "status";
  atMs: number;
  event: string;
  data?: Record<string, unknown>;
};

export type PriceFeedMessage =
  PriceFeedLaunch | PriceFeedPrice | PriceFeedStatus;

export type PriceFeedCommand =
  | {
      op: "subscribe";
      mints?: string[];
      launches?: boolean;
      allPrices?: boolean;
    }
  | { op: "unsubscribe"; mints?: string[] }
  | { op: "ping" };

export type PriceFeedClient = {
  readonly connected: boolean;
  send(command: PriceFeedCommand): void;
  close(): void;
};

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof ArrayBuffer)
    return new TextDecoder().decode(new Uint8Array(value));
  if (ArrayBuffer.isView(value))
    return new TextDecoder().decode(
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    );
  return String(value ?? "");
}

export async function connectPriceFeed(args: {
  url: string;
  subscribe: Extract<PriceFeedCommand, { op: "subscribe" }>;
  onMessage: (message: PriceFeedMessage) => void | Promise<void>;
  onStatus?: (event: string, data?: Record<string, unknown>) => void;
  signal?: AbortSignal;
}): Promise<PriceFeedClient> {
  let connected = false;
  let stopped = false;
  let socket: WebSocket | null = null;
  let reconnectDelay = 250;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    connected = false;
    try {
      socket?.close();
    } catch {}
  };
  args.signal?.addEventListener("abort", stop, { once: true });

  const open = async () => {
    while (!stopped) {
      try {
        const ws = new WebSocket(args.url);
        socket = ws;
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const timeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            try {
              ws.close();
            } catch {}
            reject(new Error("feed websocket handshake timed out"));
          }, 5_000);
          ws.addEventListener("open", () => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            connected = true;
            reconnectDelay = 250;
            ws.send(JSON.stringify(args.subscribe));
            args.onStatus?.("connected", { url: args.url });
            resolve();
          });
          ws.addEventListener("error", () => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            reject(new Error("feed websocket error"));
          });
        });

        await new Promise<void>((resolve) => {
          ws.addEventListener("message", (event) => {
            let message: PriceFeedMessage;
            try {
              message = JSON.parse(text(event.data)) as PriceFeedMessage;
            } catch {
              return;
            }
            void Promise.resolve(args.onMessage(message)).catch((error) =>
              args.onStatus?.("callback-error", {
                error: error instanceof Error ? error.message : String(error),
              }),
            );
          });
          ws.addEventListener("close", () => {
            connected = false;
            resolve();
          });
          ws.addEventListener("error", () => {
            connected = false;
          });
        });
      } catch (error) {
        connected = false;
        args.onStatus?.("connect-error", {
          error: error instanceof Error ? error.message : String(error),
          retryInMs: reconnectDelay,
        });
      }
      if (stopped) break;
      await new Promise((resolve) => setTimeout(resolve, reconnectDelay));
      reconnectDelay = Math.min(10_000, reconnectDelay * 2);
    }
  };

  void open();
  return {
    get connected() {
      return connected;
    },
    send(command) {
      if (!connected || socket?.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify(command));
    },
    close: stop,
  };
}

if (import.meta.main) {
  const url = process.argv[2] ?? "ws://127.0.0.1:8788/ws";
  await connectPriceFeed({
    url,
    subscribe: { op: "subscribe", launches: true, allPrices: true },
    onMessage(message) {
      process.stdout.write(`${JSON.stringify(message)}\n`);
    },
    onStatus(event, data) {
      process.stderr.write(`${event} ${JSON.stringify(data ?? {})}\n`);
    },
  });
  await new Promise(() => {});
}
