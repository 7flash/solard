import type {
  PriceFeedCommand,
  PriceFeedMessage,
} from "./price-feed-protocol.ts";

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

export type PriceFeedClient = {
  readonly connected: boolean;
  send(command: PriceFeedCommand): void;
  subscribeMints(mints: string[]): void;
  unsubscribeMints(mints: string[]): void;
  close(): void;
  closed: Promise<void>;
};

export async function connectPriceFeed(args: {
  url: string;
  subscribe: Extract<PriceFeedCommand, { op: "subscribe" }>;
  onMessage: (message: PriceFeedMessage) => void | Promise<void>;
  onStatus?: (event: string, data?: Record<string, unknown>) => void;
  signal?: AbortSignal;
}): Promise<PriceFeedClient> {
  let stopped = false;
  let connected = false;
  let ws: WebSocket | null = null;
  const desiredMints = new Set(args.subscribe.mints ?? []);
  let desiredLaunches = args.subscribe.launches === true;
  let desiredAllPrices = args.subscribe.allPrices === true;
  let reconnectDelay = 250;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const stop = () => {
    if (stopped) return;
    stopped = true;
    try {
      ws?.close();
    } catch {}
    resolveClosed();
  };
  args.signal?.addEventListener("abort", stop, { once: true });

  const open = async (): Promise<void> => {
    while (!stopped) {
      try {
        const socket = new WebSocket(args.url);
        ws = socket;
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const timeout = setTimeout(() => {
            if (!settled) {
              settled = true;
              try {
                socket.close();
              } catch {}
              reject(new Error("feed websocket handshake timed out"));
            }
          }, 5_000);
          socket.addEventListener("open", () => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            connected = true;
            reconnectDelay = 250;
            socket.send(
              JSON.stringify({
                op: "subscribe",
                mints: [...desiredMints],
                launches: desiredLaunches,
                allPrices: desiredAllPrices,
              } satisfies PriceFeedCommand),
            );
            args.onStatus?.("connected", { url: args.url });
            resolve();
          });
          socket.addEventListener("error", () => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            reject(new Error("feed websocket error"));
          });
        });

        await new Promise<void>((resolve) => {
          socket.addEventListener("message", (event) => {
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
          socket.addEventListener("close", () => {
            connected = false;
            resolve();
          });
          socket.addEventListener("error", () => {
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
    resolveClosed();
  };

  void open();
  const startedAt = Date.now();
  while (!connected && !stopped && Date.now() - startedAt < 6_000)
    await new Promise((resolve) => setTimeout(resolve, 25));
  if (!connected && !stopped) {
    stop();
    throw new Error(
      `Could not connect to Solard price feed at ${args.url}. Start it with: slrd feed serve`,
    );
  }

  const send = (command: PriceFeedCommand) => {
    if (command.op === "subscribe") {
      for (const mint of command.mints ?? []) desiredMints.add(mint);
      if (command.launches === true) desiredLaunches = true;
      if (command.allPrices === true) desiredAllPrices = true;
    } else if (command.op === "unsubscribe") {
      for (const mint of command.mints ?? []) desiredMints.delete(mint);
    }
    if (!connected || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(command));
  };
  return {
    get connected() {
      return connected;
    },
    send,
    subscribeMints(mints: string[]) {
      send({ op: "subscribe", mints });
    },
    unsubscribeMints(mints: string[]) {
      send({ op: "unsubscribe", mints });
    },
    close: stop,
    closed,
  };
}
