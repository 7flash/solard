import { measure } from "./measure.ts";

export interface EvmHeader {
  number: number;
  hash: string;
  parentHash?: string;
  timestamp?: number;
}

export interface EvmTransaction {
  transactionIndex?: number;
  hash?: string;
  from?: string;
  to?: string | null;
  value?: string;
  status?: number;
  gasUsed?: string;
  gasPrice?: string;
  input?: string;
}

export interface EvmLog {
  address?: string;
  topics?: string[];
  data?: string;
  logIndex?: number;
  transactionIndex?: number;
  transactionHash?: string;
}

export interface EvmBlock {
  header: EvmHeader;
  transactions?: EvmTransaction[];
  logs?: EvmLog[];
}

export interface EvmQuery {
  type: "evm";
  fromBlock: number;
  toBlock?: number;
  parentBlockHash?: string;
  includeAllBlocks?: boolean;
  fields: Record<string, Record<string, boolean>>;
  transactions?: Record<string, unknown>[];
  logs?: Record<string, unknown>[];
  traces?: Record<string, unknown>[];
}

export interface PortalHead {
  number: number;
  hash: string;
}

export interface RunPortalOptions {
  name: string;
  portalUrl?: string;
  finalized?: boolean;
  from: number;
  to?: number;
  parentBlockHash?: string;
  buildQuery: (cursor: number, parentBlockHash?: string) => EvmQuery;
  onBlock: (block: EvmBlock) => Promise<void>;
  onCheckpoint?: (nextBlock: number, parentBlockHash?: string) => void;
}

const DEFAULT_PORTAL = "https://portal.sqd.dev/datasets/robinhood-mainnet";
const RETRY_MS = positiveEnv("SQD_RETRY_MS", 3_000);
const POLL_MS = positiveEnv("SQD_POLL_MS", 1_000);
const HEARTBEAT_MS = positiveEnv("SQD_HEARTBEAT_MS", 10_000);
const TIMEOUT_MS = positiveEnv("SQD_REQUEST_TIMEOUT_MS", 60_000);
const REORG_REWIND = positiveEnv("SQD_REORG_REWIND", 128);

function positiveEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function authHeaders(): Record<string, string> {
  const key = process.env.SQD_API_KEY?.trim();
  if (!key) return {};
  const header = process.env.SQD_API_KEY_HEADER?.trim() || "authorization";
  const scheme = process.env.SQD_API_KEY_SCHEME?.trim() ?? "Bearer";
  return {
    [header]:
      header.toLowerCase() === "authorization" && scheme
        ? `${scheme} ${key}`
        : key,
  };
}

function endpointHeaders(): HeadersInit {
  return {
    "content-type": "application/json",
    accept: "application/x-ndjson, application/json",
    "accept-encoding": "gzip, br",
    ...authHeaders(),
  };
}

function parseIntHeader(response: Response, name: string): number | undefined {
  const raw = response.headers.get(name);
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

export class PortalHttpError extends Error {
  constructor(
    readonly status: number,
    readonly bodyText: string,
    readonly query?: EvmQuery,
  ) {
    super(`SQD Portal HTTP ${status}: ${bodyText.slice(0, 2_000)}`);
    this.name = "PortalHttpError";
  }
}

class PortalForkError extends Error {
  constructor(readonly previousBlocks: { number: number; hash: string }[]) {
    super("SQD Portal reported a fork");
    this.name = "PortalForkError";
  }
}

export async function fetchPortalHead(
  portalUrl = process.env.RH_SQD_PORTAL_URL ?? DEFAULT_PORTAL,
  finalized = true,
): Promise<PortalHead> {
  const base = portalUrl.replace(/\/+$/, "");
  const endpoint = finalized ? "finalized-head" : "head";
  return await measure(
    { start: () => `GET ${endpoint}`, end: (head) => head, budget: 3_000 },
    async () => {
      const response = await fetch(`${base}/${endpoint}`, {
        headers: endpointHeaders(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok)
        throw new PortalHttpError(response.status, await response.text());
      const head = (await response.json()) as Partial<PortalHead> | null;
      if (
        !head ||
        !Number.isSafeInteger(head.number) ||
        typeof head.hash !== "string"
      ) {
        throw new Error(`invalid ${endpoint} response`);
      }
      return head as PortalHead;
    },
  );
}

async function* parseBlocks(response: Response): AsyncGenerator<EvmBlock> {
  if (!response.body) throw new Error("Portal returned no response body");
  const contentType = response.headers.get("content-type") ?? "";
  if (
    contentType.includes("application/json") &&
    !contentType.includes("ndjson")
  ) {
    const text = await response.text();
    const parsed = JSON.parse(text) as EvmBlock | EvmBlock[];
    for (const block of Array.isArray(parsed) ? parsed : [parsed]) yield block;
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) yield JSON.parse(line) as EvmBlock;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) yield JSON.parse(buffer.trim()) as EvmBlock;
  } finally {
    reader.releaseLock();
  }
}

async function requestBatch(
  base: string,
  finalized: boolean,
  query: EvmQuery,
  onBlock: (block: EvmBlock) => Promise<void>,
): Promise<{
  blocks: number;
  last?: EvmHeader;
  head?: number;
  finalizedHead?: number;
}> {
  const endpoint = finalized ? "finalized-stream" : "stream";
  return await measure(
    {
      start: () =>
        `POST ${endpoint} from=${query.fromBlock}${query.toBlock === undefined ? "" : ` to=${query.toBlock}`}`,
      end: (result) => result,
      budget: 10_000,
      maxResultLength: 2_000,
    },
    async () => {
      const response = await fetch(`${base}/${endpoint}`, {
        method: "POST",
        headers: endpointHeaders(),
        body: JSON.stringify(query),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const head = parseIntHeader(response, "x-sqd-head-number");
      const finalizedHead = parseIntHeader(
        response,
        "x-sqd-finalized-head-number",
      );
      if (response.status === 204) return { blocks: 0, head, finalizedHead };
      if (response.status === 409) {
        const text = await response.text();
        try {
          const body = JSON.parse(text) as {
            previousBlocks?: { number: number; hash: string }[];
          };
          throw new PortalForkError(body.previousBlocks ?? []);
        } catch (error) {
          if (error instanceof PortalForkError) throw error;
          throw new PortalHttpError(409, text, query);
        }
      }
      if (!response.ok)
        throw new PortalHttpError(
          response.status,
          await response.text(),
          query,
        );
      let blocks = 0;
      let last: EvmHeader | undefined;
      for await (const block of parseBlocks(response)) {
        if (
          !block.header ||
          !Number.isSafeInteger(block.header.number) ||
          typeof block.header.hash !== "string"
        ) {
          throw new Error("Portal returned malformed EVM block header");
        }
        await onBlock(block);
        blocks++;
        last = block.header;
      }
      return { blocks, last, head, finalizedHead };
    },
  );
}

export async function runPortal(options: RunPortalOptions): Promise<void> {
  const base = (
    options.portalUrl ??
    process.env.RH_SQD_PORTAL_URL ??
    DEFAULT_PORTAL
  ).replace(/\/+$/, "");
  const finalized = options.finalized ?? process.env.SQD_FINALIZED !== "0";
  let cursor = options.from;
  let parentBlockHash = options.parentBlockHash;
  let running = true;
  const status = {
    startedAt: Date.now(),
    requests: 0,
    blocks: 0,
    noData: 0,
    errors: 0,
    forks: 0,
    cursor,
    head: 0,
    finalizedHead: 0,
    lastBlockAt: 0,
  };
  const stop = () => {
    running = false;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const heartbeat = setInterval(() => {
    measure.sync(
      {
        start: () => `${options.name}.heartbeat`,
        end: (value) => value,
        summarize: false,
      },
      () => ({
        ...status,
        finalized,
        uptimeMs: Date.now() - status.startedAt,
        lastBlockAgeMs: status.lastBlockAt
          ? Date.now() - status.lastBlockAt
          : null,
      }),
    );
  }, HEARTBEAT_MS);
  (heartbeat as any).unref?.();
  try {
    while (running) {
      if (options.to !== undefined && cursor > options.to) break;
      const query = options.buildQuery(cursor, parentBlockHash);
      if (query.fromBlock !== cursor)
        throw new Error("buildQuery must preserve runner cursor");
      if (options.to !== undefined) query.toBlock = options.to;
      if (parentBlockHash) query.parentBlockHash = parentBlockHash;
      status.requests++;
      try {
        const result = await requestBatch(
          base,
          finalized,
          query,
          async (block) => {
            await options.onBlock(block);
            cursor = block.header.number + 1;
            parentBlockHash = block.header.hash;
            status.cursor = cursor;
            status.blocks++;
            status.lastBlockAt = Date.now();
            options.onCheckpoint?.(cursor, parentBlockHash);
          },
        );
        if (result.head !== undefined) status.head = result.head;
        if (result.finalizedHead !== undefined)
          status.finalizedHead = result.finalizedHead;
        if (result.blocks === 0) {
          status.noData++;
          if (options.to !== undefined && status.head >= options.to) break;
          await sleep(POLL_MS);
        }
      } catch (error) {
        if (error instanceof PortalForkError) {
          status.forks++;
          const common = [...error.previousBlocks]
            .reverse()
            .find((point) => point.hash === parentBlockHash);
          if (common) {
            cursor = common.number + 1;
            parentBlockHash = common.hash;
          } else {
            cursor = Math.max(options.from, cursor - REORG_REWIND);
            parentBlockHash = undefined;
          }
          status.cursor = cursor;
          console.warn(`[${options.name}] fork; resume block ${cursor}`);
          continue;
        }
        status.errors++;
        if (error instanceof PortalHttpError && error.status === 400) {
          console.error(
            `[${options.name}] query rejected:\n${error.bodyText}\n${JSON.stringify(error.query, null, 2)}`,
          );
          throw error;
        }
        console.error(
          `[${options.name}] ${error instanceof Error ? error.message : String(error)}; retrying in ${RETRY_MS}ms`,
        );
        await sleep(RETRY_MS);
      }
    }
  } finally {
    clearInterval(heartbeat);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
