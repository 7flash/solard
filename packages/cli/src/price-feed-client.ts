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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type PriceFeedClient = {
  readonly connected: boolean;
  subscribeMints(mints: string | readonly string[]): void;
  unsubscribeMints(mints: string | readonly string[]): void;
  listMints(): string[];
  close(): void;
  closed: Promise<void>;
};

export async function connectPriceFeed(args: {
  url: string;
  mints?: string | readonly string[];
  onMessage: (message: PriceFeedMessage) => void | Promise<void>;
  onStatus?: (event: string, data?: Record<string, unknown>) => void;
  signal?: AbortSignal;
}): Promise<PriceFeedClient> {
  let stopped = false;
  let connected = false;
  let ws: WebSocket | null = null;
  const desiredMints = new Set(
    (typeof args.mints === "string" ? [args.mints] : [...(args.mints ?? [])])
      .map((mint) => mint.trim())
      .filter(Boolean),
  );
  let reconnectDelay = 250;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const send = (command: PriceFeedCommand): void => {
    if (!connected || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(command));
  };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    connected = false;
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
            if (settled) return;
            settled = true;
            try {
              socket.close();
            } catch {}
            reject(new Error("price feed websocket handshake timed out"));
          }, 5_000);
          socket.addEventListener("open", () => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            connected = true;
            reconnectDelay = 250;
            const mints = [...desiredMints];
            if (mints.length)
              socket.send(JSON.stringify({ op: "subscribe", mints }));
            args.onStatus?.("connected", { url: args.url, mints });
            resolve();
          });
          socket.addEventListener("error", () => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            reject(new Error("price feed websocket error"));
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
              args.onStatus?.("callback-error", { error: errorText(error) }),
            );
          });
          socket.addEventListener("close", () => {
            connected = false;
            args.onStatus?.("disconnected", { url: args.url });
            resolve();
          });
          socket.addEventListener("error", () => {
            connected = false;
          });
        });
      } catch (error) {
        connected = false;
        args.onStatus?.("connect-error", {
          error: errorText(error),
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
      `Could not connect to Solard price feed at ${args.url}. Start the shared price feed before starting traders.`,
    );
  }

  return {
    get connected() {
      return connected;
    },
    subscribeMints(value) {
      const mints = (typeof value === "string" ? [value] : [...value])
        .map((mint) => mint.trim())
        .filter((mint) => mint && !desiredMints.has(mint));
      if (!mints.length) return;
      for (const mint of mints) desiredMints.add(mint);
      send({ op: "subscribe", mints });
    },
    unsubscribeMints(value) {
      const mints = (typeof value === "string" ? [value] : [...value])
        .map((mint) => mint.trim())
        .filter((mint) => mint && desiredMints.has(mint));
      if (!mints.length) return;
      for (const mint of mints) desiredMints.delete(mint);
      send({ op: "unsubscribe", mints });
    },
    listMints() {
      return [...desiredMints];
    },
    close: stop,
    closed,
  };
}
