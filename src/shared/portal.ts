import { configure, createMeasure } from "measure-fn";

configure({
  summarize: true,
  maxResultLength: 4_000,
  sensitiveKeyPattern:
    /secret|private|mnemonic|seed|keypair|password|authorization|cookie|token|apikey|api_key/i,
});

export const measure = createMeasure("sqd-trackers");

export interface PortalHead {
  number: number;
  hash: string;
}

export interface PortalTransaction {
  transactionIndex: number;
  signatures?: string[];
  err?: null | object;
  fee?: number;
  feePayer?: string;
}

export interface PortalTokenBalance {
  transactionIndex: number;
  account?: string;
  preMint?: string;
  postMint?: string;
  preOwner?: string;
  postOwner?: string;
  preAmount?: string;
  postAmount?: string;
  preDecimals?: number;
  postDecimals?: number;
}

export interface PortalBalance {
  transactionIndex: number;
  account?: string;
  pre?: string | number;
  post?: string | number;
}

export interface PortalInstruction {
  transactionIndex: number;
  instructionAddress: number[];
  programId?: string;
  accounts?: string[];
  data?: string;
  isCommitted?: boolean;
}

export interface PortalBlock {
  header: {
    number: number;
    hash: string;
    parentNumber?: number;
    parentHash?: string;
    height?: number;
    timestamp?: number;
  };
  transactions?: PortalTransaction[];
  tokenBalances?: PortalTokenBalance[];
  balances?: PortalBalance[];
  instructions?: PortalInstruction[];
}

export interface PortalQuery {
  type: "solana";
  fromBlock: number;
  toBlock?: number;
  parentBlockHash?: string;
  fields: Record<string, Record<string, boolean>>;
  [key: string]: unknown;
}

export interface PortalRunnerOptions {
  name: string;
  portalUrl?: string;
  finalized?: boolean;
  from: number;
  to?: number;
  retryMs?: number;
  pollMs?: number;
  heartbeatMs?: number;
  requestTimeoutMs?: number;
  reorgRewind?: number;
  buildQuery: (cursor: number, parentBlockHash?: string) => PortalQuery;
  onBlock: (block: PortalBlock) => Promise<void>;
  onCursor?: (nextCursor: number, parentBlockHash?: string) => void;
}

interface PreviousBlock {
  number: number;
  hash: string;
}

class PortalHttpError extends Error {
  constructor(
    readonly status: number,
    readonly bodyText: string,
    readonly query: PortalQuery,
  ) {
    super(`SQD Portal HTTP ${status}: ${bodyText.slice(0, 2_000)}`);
    this.name = "PortalHttpError";
  }
}

class PortalForkError extends Error {
  constructor(readonly previousBlocks: PreviousBlock[]) {
    super("SQD Portal reported a hot-chain fork");
    this.name = "PortalForkError";
  }
}

function integerHeader(response: Response, name: string): number | undefined {
  const value = response.headers.get(name);
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function* readNdjson(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ block: PortalBlock; bytes: number }> {
  const reader = body.getReader();
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
        if (!line) continue;
        yield {
          block: JSON.parse(line) as PortalBlock,
          bytes: Buffer.byteLength(line),
        };
      }
    }

    buffer += decoder.decode();
    const line = buffer.trim();
    if (line) {
      yield {
        block: JSON.parse(line) as PortalBlock,
        bytes: Buffer.byteLength(line),
      };
    }
  } finally {
    reader.releaseLock();
  }
}

export async function getPortalHead(
  portalUrl: string,
  finalized = true,
  requestTimeoutMs = 60_000,
): Promise<PortalHead> {
  const endpoint = finalized ? "finalized-head" : "head";
  const url = `${portalUrl.replace(/\/+$/, "")}/${endpoint}`;

  return await measure(
    {
      start: () => `GET ${endpoint}`,
      end: (head) => head,
      budget: 3_000,
    },
    async () => {
      const response = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (!response.ok) {
        throw new Error(
          `GET ${url} returned ${response.status}: ${await response.text()}`,
        );
      }
      const head = (await response.json()) as PortalHead;
      if (
        !Number.isSafeInteger(head?.number) ||
        typeof head?.hash !== "string"
      ) {
        throw new Error(`GET ${url} returned an invalid head`);
      }
      return head;
    },
  );
}

export async function runPortal(options: PortalRunnerOptions): Promise<void> {
  const portalUrl = (
    options.portalUrl ??
    process.env.PORTAL_URL ??
    "https://portal.sqd.dev/datasets/solana-mainnet"
  ).replace(/\/+$/, "");
  const finalized = options.finalized ?? true;
  const endpoint = finalized ? "finalized-stream" : "stream";
  const retryMs = options.retryMs ?? 3_000;
  const pollMs = options.pollMs ?? 1_000;
  const heartbeatMs = options.heartbeatMs ?? 10_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
  const reorgRewind = options.reorgRewind ?? 128;

  let cursor = options.from;
  let parentBlockHash: string | undefined;
  let sourceHead = cursor;
  let finalizedHead = 0;
  let running = true;

  const recentHeaders = new Map<number, string>();
  const stats = {
    startedAtMs: Date.now(),
    requests: 0,
    blocks: 0,
    bytes: 0,
    noData: 0,
    errors: 0,
    forks: 0,
    lastBlockAtMs: 0,
  };

  const heartbeat = setInterval(() => {
    measure.sync(
      {
        start: () => `${options.name}:heartbeat`,
        end: (value) => value,
        summarize: false,
      },
      () => ({
        finalized,
        cursor,
        sourceHead,
        finalizedHead: finalizedHead || null,
        slotLag: Math.max(0, sourceHead - cursor),
        uptimeMs: Date.now() - stats.startedAtMs,
        lastBlockAgeMs: stats.lastBlockAtMs
          ? Date.now() - stats.lastBlockAtMs
          : null,
        requests: stats.requests,
        blocks: stats.blocks,
        noData: stats.noData,
        errors: stats.errors,
        forks: stats.forks,
        mib: Number((stats.bytes / 1024 / 1024).toFixed(3)),
      }),
    );
  }, heartbeatMs);
  (heartbeat as any).unref?.();

  const stop = () => {
    running = false;
    clearInterval(heartbeat);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  while (running) {
    if (options.to !== undefined && cursor > options.to) break;

    const query = options.buildQuery(cursor, parentBlockHash);
    query.fromBlock = cursor;
    if (options.to !== undefined) query.toBlock = options.to;
    if (!finalized && parentBlockHash) query.parentBlockHash = parentBlockHash;

    stats.requests++;

    try {
      await measure(
        {
          start: () => `${options.name}:POST ${endpoint} from=${cursor}`,
          end: (value) => value,
          budget: 10_000,
        },
        async () => {
          const response = await fetch(`${portalUrl}/${endpoint}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/x-ndjson, application/json",
            },
            body: JSON.stringify(query),
            signal: AbortSignal.timeout(requestTimeoutMs),
          });

          sourceHead =
            integerHeader(response, "x-sqd-head-number") ?? sourceHead;
          finalizedHead =
            integerHeader(response, "x-sqd-finalized-head-number") ??
            finalizedHead;

          if (response.status === 204) {
            stats.noData++;
            if (options.to !== undefined && sourceHead >= options.to) {
              cursor = options.to + 1;
              return { status: 204, blocks: 0 };
            }
            await sleep(pollMs);
            return { status: 204, blocks: 0 };
          }

          if (response.status === 409) {
            const text = await response.text();
            let body: { previousBlocks?: PreviousBlock[] } = {};
            try {
              body = JSON.parse(text) as { previousBlocks?: PreviousBlock[] };
            } catch {
              throw new PortalHttpError(409, text, query);
            }
            throw new PortalForkError(body.previousBlocks ?? []);
          }

          if (!response.ok) {
            throw new PortalHttpError(
              response.status,
              await response.text(),
              query,
            );
          }
          if (!response.body)
            throw new Error("Portal returned 200 without a body");

          let batchBlocks = 0;
          for await (const item of readNdjson(response.body)) {
            const block = item.block;
            if (
              !Number.isSafeInteger(block.header?.number) ||
              !block.header?.hash
            ) {
              throw new Error("Portal returned a malformed block header");
            }

            await options.onBlock(block);

            stats.blocks++;
            stats.bytes += item.bytes;
            stats.lastBlockAtMs = Date.now();
            batchBlocks++;

            recentHeaders.set(block.header.number, block.header.hash);
            while (recentHeaders.size > 512) {
              const oldest = recentHeaders.keys().next().value;
              if (oldest !== undefined) recentHeaders.delete(oldest);
            }

            cursor = block.header.number + 1;
            parentBlockHash = block.header.hash;
            options.onCursor?.(cursor, parentBlockHash);
          }

          return { status: response.status, blocks: batchBlocks };
        },
      );
    } catch (error) {
      if (error instanceof PortalForkError) {
        stats.forks++;
        let common: PreviousBlock | undefined;
        for (const point of error.previousBlocks) {
          if (recentHeaders.get(point.number) === point.hash) {
            common = point;
            break;
          }
        }

        if (common) {
          cursor = common.number + 1;
          parentBlockHash = common.hash;
          for (const slot of [...recentHeaders.keys()]) {
            if (slot > common.number) recentHeaders.delete(slot);
          }
        } else {
          cursor = Math.max(options.from, cursor - reorgRewind);
          parentBlockHash = undefined;
        }
        continue;
      }

      stats.errors++;
      if (error instanceof PortalHttpError && error.status === 400) {
        console.error(
          `[${options.name}] Portal rejected the query\n` +
            `response: ${error.bodyText}\n` +
            `query: ${JSON.stringify(error.query, null, 2)}`,
        );
        throw error;
      }

      console.error(
        `[${options.name}] ${errorText(error)}; retrying in ${retryMs}ms`,
      );
      await sleep(retryMs);
    }
  }

  clearInterval(heartbeat);
}

export function timestampMs(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) return Date.now();
  return value > 100_000_000_000
    ? Math.trunc(value)
    : Math.trunc(value * 1_000);
}

export function transactionMap(
  block: PortalBlock,
): Map<number, PortalTransaction> {
  return new Map(
    (block.transactions ?? []).map((tx) => [tx.transactionIndex, tx]),
  );
}
