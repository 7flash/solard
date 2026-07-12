import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";

import type { LaunchReporter } from "./token-launch.js";

export type ArmedBuyerEndpoint = {
  label: string;
  host: string;
  port: number;
};

type ControlMessage = {
  version: 1;
  type: "ping" | "fire" | "abort";
  session: string;
  mint: string;
  reason?: string;
};

type ControlReply = {
  version: 1;
  type: "ready" | "accepted" | "aborting" | "error";
  session: string;
  mint: string;
  group: string;
  message?: string;
};

export type ArmedBuyerServer = {
  endpoint: ArmedBuyerEndpoint;
  close(): Promise<void>;
};

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid armed-buyer port: ${value}`);
  }
  return port;
}

export function parseArmedBuyerEndpoint(value: string): ArmedBuyerEndpoint {
  const cleaned = value.trim();
  if (!cleaned) throw new Error("Armed-buyer endpoint is empty.");

  const equalsAt = cleaned.indexOf("=");
  const label =
    equalsAt >= 0 ? cleaned.slice(0, equalsAt).trim() || "buyers" : "buyers";
  const address = equalsAt >= 0 ? cleaned.slice(equalsAt + 1).trim() : cleaned;
  const colonAt = address.lastIndexOf(":");

  if (colonAt <= 0 || colonAt === address.length - 1) {
    throw new Error(
      `Invalid armed-buyer endpoint ${JSON.stringify(value)}. Expected label=127.0.0.1:port.`,
    );
  }

  const host = address.slice(0, colonAt).trim();
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error(`Armed-buyer control must be loopback-only; got ${host}.`);
  }

  return {
    label,
    host,
    port: parsePort(address.slice(colonAt + 1)),
  };
}

function encode(value: ControlMessage | ControlReply): string {
  return `${JSON.stringify(value)}\n`;
}

function decode(line: string): ControlMessage {
  const parsed = JSON.parse(line) as Partial<ControlMessage>;
  if (
    parsed.version !== 1 ||
    (parsed.type !== "ping" &&
      parsed.type !== "fire" &&
      parsed.type !== "abort") ||
    typeof parsed.session !== "string" ||
    typeof parsed.mint !== "string"
  ) {
    throw new Error("Invalid armed-buyer control message.");
  }
  return parsed as ControlMessage;
}

function reply(socket: Socket, value: ControlReply): void {
  socket.write(encode(value));
}

export async function createArmedBuyerServer(args: {
  endpoint: ArmedBuyerEndpoint;
  session: string;
  group: string;
  mint: string;
  onFire(): void;
  onAbort(reason?: string): void;
  reporter?: LaunchReporter;
}): Promise<ArmedBuyerServer> {
  let fired = false;

  const server: Server = createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";

    socket.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const newline = buffer.indexOf("\n");
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;

        try {
          const message = decode(line);
          if (message.session !== args.session || message.mint !== args.mint) {
            throw new Error("Session or mint mismatch.");
          }

          if (message.type === "ping") {
            reply(socket, {
              version: 1,
              type: "ready",
              session: args.session,
              mint: args.mint,
              group: args.group,
            });
            continue;
          }

          if (message.type === "abort") {
            reply(socket, {
              version: 1,
              type: "aborting",
              session: args.session,
              mint: args.mint,
              group: args.group,
            });
            args.onAbort(message.reason);
            continue;
          }

          reply(socket, {
            version: 1,
            type: "accepted",
            session: args.session,
            mint: args.mint,
            group: args.group,
            message: fired ? "already released" : undefined,
          });

          if (!fired) {
            fired = true;
            args.reporter?.("pump armed buyers released", {
              session: args.session,
              group: args.group,
              mint: args.mint,
            });
            // The acknowledgement is queued before buyer work begins.
            queueMicrotask(args.onFire);
          }
        } catch (error) {
          reply(socket, {
            version: 1,
            type: "error",
            session: args.session,
            mint: args.mint,
            group: args.group,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(args.endpoint.port, args.endpoint.host);
  });

  args.reporter?.("pump buyers armed", {
    session: args.session,
    group: args.group,
    mint: args.mint,
    endpoint: `${args.endpoint.host}:${args.endpoint.port}`,
  });

  return {
    endpoint: args.endpoint,
    close: async () => {
      if (!server.listening) return;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function sendControl(
  endpoint: ArmedBuyerEndpoint,
  message: ControlMessage,
  expected: ControlReply["type"][],
  timeoutMs: number,
): Promise<ControlReply> {
  return await new Promise<ControlReply>((resolve, reject) => {
    let settled = false;
    let buffer = "";
    const socket = createConnection({
      host: endpoint.host,
      port: endpoint.port,
    });

    const finish = (error?: Error, value?: ControlReply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value!);
    };

    const timer = setTimeout(
      () =>
        finish(
          new Error(
            `Timed out contacting armed buyer ${endpoint.label} at ${endpoint.host}:${endpoint.port}.`,
          ),
        ),
      timeoutMs,
    );
    timer.unref?.();

    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(encode(message)));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;

      try {
        const value = JSON.parse(buffer.slice(0, newline)) as ControlReply;
        if (value.type === "error") {
          throw new Error(value.message || "Armed buyer rejected request.");
        }
        if (!expected.includes(value.type)) {
          throw new Error(`Unexpected armed-buyer reply: ${value.type}`);
        }
        finish(undefined, value);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.on("error", (error) => finish(error));
    socket.on("close", () => {
      if (!settled) {
        finish(
          new Error(
            `Armed buyer ${endpoint.label} closed without acknowledgement.`,
          ),
        );
      }
    });
  });
}

export async function assertArmedBuyerEndpointsReady(args: {
  endpoints: ArmedBuyerEndpoint[];
  session: string;
  mint: string;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = args.timeoutMs ?? 1_000;
  await Promise.all(
    args.endpoints.map((endpoint) =>
      sendControl(
        endpoint,
        {
          version: 1,
          type: "ping",
          session: args.session,
          mint: args.mint,
        },
        ["ready"],
        timeoutMs,
      ),
    ),
  );
}

export async function releaseArmedBuyerEndpoints(args: {
  endpoints: ArmedBuyerEndpoint[];
  session: string;
  mint: string;
  timeoutMs?: number;
  reporter?: LaunchReporter;
}): Promise<void> {
  const accepted = await Promise.all(
    args.endpoints.map((endpoint) =>
      sendControl(
        endpoint,
        {
          version: 1,
          type: "fire",
          session: args.session,
          mint: args.mint,
        },
        ["accepted"],
        args.timeoutMs ?? 1_000,
      ),
    ),
  );

  args.reporter?.("pump armed buyer fire accepted", {
    session: args.session,
    mint: args.mint,
    groups: accepted.map((item) => item.group),
  });
}

export async function abortArmedBuyerEndpoints(args: {
  endpoints: ArmedBuyerEndpoint[];
  session: string;
  mint: string;
  reason?: string;
  timeoutMs?: number;
  reporter?: LaunchReporter;
}): Promise<void> {
  const results = await Promise.allSettled(
    args.endpoints.map((endpoint) =>
      sendControl(
        endpoint,
        {
          version: 1,
          type: "abort",
          session: args.session,
          mint: args.mint,
          reason: args.reason,
        },
        ["aborting"],
        args.timeoutMs ?? 500,
      ),
    ),
  );

  args.reporter?.("pump armed buyer abort sent", {
    session: args.session,
    mint: args.mint,
    fulfilled: results.filter((item) => item.status === "fulfilled").length,
    rejected: results.filter((item) => item.status === "rejected").length,
  });
}
