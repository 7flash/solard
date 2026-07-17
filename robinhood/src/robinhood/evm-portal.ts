// Minimal EVM Portal stream client (NDJSON batches).

export interface EvmPortalBlock {
  header: {
    number: number;
    hash: string;
    parentHash?: string;
    timestamp?: number;
  };
  logs?: EvmLog[];
}

export interface EvmLog {
  address: string;
  topics: string[];
  data: string;
  transactionHash?: string;
  logIndex?: number;
  transactionIndex?: number;
}

export interface EvmPortalQuery {
  type: "evm";
  fromBlock: number;
  toBlock?: number;
  fields: Record<string, any>;
  logs?: any[];
}

export async function getEvmHead(
  portalUrl: string,
  apiKey?: string,
): Promise<{ number: number; hash: string }> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (apiKey) headers["authorization"] = `Bearer ${apiKey}`;

  const res = await fetch(`${portalUrl.replace(/\/+$/, "")}/head`, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`head HTTP ${res.status}: ${await res.text()}`);
  const j = (await res.json()) as { number: number; hash: string };
  if (!Number.isFinite(j.number)) throw new Error("invalid head");
  return j;
}

async function* readNdjson(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<EvmPortalBlock> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      while (true) {
        const nl = buf.indexOf("\n");
        if (nl < 0) break;
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        yield JSON.parse(line) as EvmPortalBlock;
      }
    }
    buf += decoder.decode();
    const last = buf.trim();
    if (last) yield JSON.parse(last) as EvmPortalBlock;
  } finally {
    reader.releaseLock();
  }
}

export async function runEvmPortal(opts: {
  portalUrl: string;
  apiKey?: string;
  from: number;
  buildQuery: (from: number) => EvmPortalQuery;
  onBlock: (block: EvmPortalBlock) => Promise<void>;
  pollMs?: number;
  retryMs?: number;
}): Promise<void> {
  const base = opts.portalUrl.replace(/\/+$/, "");
  const pollMs = opts.pollMs ?? 1000;
  const retryMs = opts.retryMs ?? 3000;
  let cursor = opts.from;

  for (;;) {
    const query = opts.buildQuery(cursor);
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/x-ndjson, application/json",
      };
      if (opts.apiKey) headers["authorization"] = `Bearer ${opts.apiKey}`;

      const res = await fetch(`${base}/stream`, {
        method: "POST",
        headers,
        body: JSON.stringify(query),
        signal: AbortSignal.timeout(60_000),
      });

      if (res.status === 204) {
        await sleep(pollMs);
        continue;
      }
      if (res.status === 409) {
        // Fork — rewind a bit
        cursor = Math.max(0, cursor - 32);
        console.warn(`[evm-portal] 409 fork, rewind to ${cursor}`);
        await sleep(500);
        continue;
      }
      if (!res.ok) {
        const body = await res.text();
        console.error(`[evm-portal] HTTP ${res.status}: ${body.slice(0, 500)}`);
        if (res.status === 400) throw new Error(body);
        await sleep(retryMs);
        continue;
      }
      if (!res.body) {
        await sleep(retryMs);
        continue;
      }

      let last = cursor - 1;
      for await (const block of readNdjson(res.body)) {
        if (!block.header || !Number.isFinite(block.header.number)) continue;
        await opts.onBlock(block);
        last = block.header.number;
      }
      if (last >= cursor) {
        cursor = last + 1;
      } else {
        await sleep(pollMs);
      }
    } catch (err) {
      console.error(`[evm-portal] ${err}`);
      await sleep(retryMs);
    }
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
