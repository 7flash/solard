// pump-monitor.ts — Case 1: track all new pump.fun token launches.
//
// Strategy: logsSubscribe(mentions: [PUMP_PROGRAM]) — the ONE address fits the
// free method's single-address limit. We do NOT use programSubscribe (create-vs-
// update ambiguity + shared-RPC throttling, as discussed). Instead of the
// logsSubscribe → getTransaction round-trip, we decode the anchor CreateEvent
// straight out of the "Program data:" log line — zero extra RPC calls, and the
// event carries name/symbol/uri/mint/bondingCurve/creator directly.
//
// Fallback: if logs are truncated (compute-heavy tx) and the event can't be
// decoded, we optionally fall back to getTransaction for that signature only.
//
// Run:  RPC_WS_URL=wss://mainnet.helius-rpc.com/?api-key=KEY bun pump-monitor.ts
//   or: HELIUS_API_KEY=KEY bun pump-monitor.ts
//   (works on any RPC supporting logsSubscribe, not just Helius)

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

import { PUMPFUN_PROGRAM_ID as PUMP_PROGRAM } from "../src/solard/pump/pump-parser.js";

const WS_URL =
  process.env.RPC_WS_URL ??
  (process.env.HELIUS_API_KEY
    ? `wss://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
    : null);

const HTTP_URL =
  process.env.RPC_HTTP_URL ??
  (process.env.HELIUS_API_KEY
    ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
    : (WS_URL?.replace(/^wss:/, "https:") ?? null));

const CONFIG = {
  // "processed" = fastest (creates on forks are vanishingly rare and self-evident
  // when the curve account doesn't exist); "confirmed" if you feed automation.
  commitment: (process.env.COMMITMENT ?? "processed") as
    "processed" | "confirmed" | "finalized",
  pingIntervalMs: 25_000, // Helius idles out sockets; keep-alive well under 60s
  backoffBaseMs: 500,
  backoffMaxMs: 20_000,
  sigLruSize: 4_096, // dedupe window across reconnect overlap
  fallbackFetchTx: true, // getTransaction when event decode fails
};

// ---------------------------------------------------------------------------
// base58 (encode only — no deps)
// ---------------------------------------------------------------------------

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}

// ---------------------------------------------------------------------------
// borsh reader + CreateEvent decode
// ---------------------------------------------------------------------------

// sha256("event:CreateEvent")[0..8] — verified
const CREATE_EVENT_DISC = "1b72a94ddeeb6376";

class Reader {
  #view: DataView;
  #off = 0;
  constructor(public buf: Uint8Array) {
    this.#view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  get remaining() {
    return this.buf.length - this.#off;
  }
  bytes(n: number): Uint8Array {
    if (this.remaining < n)
      throw new Error(`buffer underrun (need ${n}, have ${this.remaining})`);
    const out = this.buf.subarray(this.#off, this.#off + n);
    this.#off += n;
    return out;
  }
  u32(): number {
    const v = this.#view.getUint32(this.#off, true);
    this.#off += 4;
    return v;
  }
  u64(): bigint {
    const v = this.#view.getBigUint64(this.#off, true);
    this.#off += 8;
    return v;
  }
  i64(): bigint {
    const v = this.#view.getBigInt64(this.#off, true);
    this.#off += 8;
    return v;
  }
  string(): string {
    const len = this.u32();
    if (len > this.remaining)
      throw new Error(`string len ${len} exceeds buffer`);
    return new TextDecoder().decode(this.bytes(len));
  }
  pubkey(): string {
    return base58(this.bytes(32));
  }
}

export interface NewTokenEvent {
  signature: string;
  slot: number;
  detectedAt: number; // Date.now() at decode
  name: string;
  symbol: string;
  uri: string;
  mint: string;
  bondingCurve: string;
  user: string; // tx signer / deployer
  // present on newer program versions (decoded opportunistically):
  creator?: string;
  timestamp?: bigint;
  virtualTokenReserves?: bigint;
  virtualSolReserves?: bigint;
  realTokenReserves?: bigint;
  tokenTotalSupply?: bigint;
}

export function decodeCreateEvent(
  data: Uint8Array,
  ctx: { signature: string; slot: number },
): NewTokenEvent | null {
  if (data.length < 8) return null;
  const disc = Buffer.from(data.subarray(0, 8)).toString("hex");
  if (disc !== CREATE_EVENT_DISC) return null;

  const r = new Reader(data.subarray(8));
  const ev: NewTokenEvent = {
    signature: ctx.signature,
    slot: ctx.slot,
    detectedAt: Date.now(),
    name: r.string(),
    symbol: r.string(),
    uri: r.string(),
    mint: r.pubkey(),
    bondingCurve: r.pubkey(),
    user: r.pubkey(),
  };
  // Newer IDL appended fields; decode what's actually there and stop cleanly.
  try {
    if (r.remaining >= 32) ev.creator = r.pubkey();
    if (r.remaining >= 8) ev.timestamp = r.i64();
    if (r.remaining >= 8) ev.virtualTokenReserves = r.u64();
    if (r.remaining >= 8) ev.virtualSolReserves = r.u64();
    if (r.remaining >= 8) ev.realTokenReserves = r.u64();
    if (r.remaining >= 8) ev.tokenTotalSupply = r.u64();
  } catch {
    /* trailing fields are best-effort */
  }
  return ev;
}

// Pull every "Program data: <b64>" payload out of a logs array.
export function extractProgramData(logs: string[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const line of logs) {
    if (!line.startsWith("Program data: ")) continue;
    try {
      const b64 = line.slice("Program data: ".length);
      out.push(Uint8Array.from(Buffer.from(b64, "base64")));
    } catch {
      /* malformed line — skip */
    }
  }
  return out;
}

// Fast pre-filter so we don't base64-decode the buy/sell firehose.
export function looksLikeCreate(logs: string[]): boolean {
  return logs.some((l) => l.includes("Instruction: Create"));
}

// ---------------------------------------------------------------------------
// LRU signature set (dedupe across reconnect overlap / duplicate delivery)
// ---------------------------------------------------------------------------

class LruSet {
  #set = new Set<string>();
  constructor(private cap: number) {}
  addIfNew(key: string): boolean {
    if (this.#set.has(key)) return false;
    this.#set.add(key);
    if (this.#set.size > this.cap) {
      // Set iterates in insertion order — evict oldest
      const oldest = this.#set.values().next().value!;
      this.#set.delete(oldest);
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// getTransaction fallback (truncated logs only)
// ---------------------------------------------------------------------------

async function fetchTxLogs(signature: string): Promise<string[] | null> {
  if (!HTTP_URL) return null;
  try {
    const res = await fetch(HTTP_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTransaction",
        params: [
          signature,
          { maxSupportedTransactionVersion: 0, commitment: "confirmed" },
        ],
      }),
    });
    const json = (await res.json()) as any;
    return json?.result?.meta?.logMessages ?? null;
  } catch (e) {
    console.error(`[fallback] getTransaction ${signature} failed:`, e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// websocket manager: subscribe / ping / reconnect with backoff+jitter
// ---------------------------------------------------------------------------

export class PumpMonitor {
  #ws: WebSocket | null = null;
  #attempt = 0;
  #pingTimer: ReturnType<typeof setInterval> | null = null;
  #sigLru = new LruSet(CONFIG.sigLruSize);
  #seenMints = new Set<string>(); // guard against dup creates, feeds cases 2/3 later
  #nextId = 1;
  #stopped = false;

  constructor(private onToken: (ev: NewTokenEvent) => void) {}

  start() {
    if (!WS_URL) {
      console.error("Set RPC_WS_URL or HELIUS_API_KEY");
      process.exit(1);
    }
    this.#connect();
  }

  stop() {
    this.#stopped = true;
    this.#clearPing();
    this.#ws?.close();
  }

  #connect() {
    if (this.#stopped) return;
    const url = WS_URL!;
    console.log(
      `[ws] connecting (attempt ${this.#attempt + 1}) commitment=${CONFIG.commitment}`,
    );
    const ws = new WebSocket(url);
    this.#ws = ws;

    ws.onopen = () => {
      this.#attempt = 0;
      this.#subscribe();
      this.#startPing();
      console.log("[ws] open, subscribed to pump.fun logs");
    };

    ws.onmessage = (msg) => this.#handle(String(msg.data));

    ws.onerror = (e) => console.error("[ws] error:", (e as any)?.message ?? e);

    ws.onclose = () => {
      this.#clearPing();
      if (this.#stopped) return;
      const delay = Math.min(
        CONFIG.backoffBaseMs * 2 ** this.#attempt,
        CONFIG.backoffMaxMs,
      );
      const jittered = delay / 2 + Math.random() * (delay / 2);
      this.#attempt++;
      console.warn(`[ws] closed — reconnecting in ${Math.round(jittered)}ms`);
      setTimeout(() => this.#connect(), jittered);
    };
  }

  #subscribe() {
    this.#ws!.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: this.#nextId++,
        method: "logsSubscribe",
        params: [
          { mentions: [PUMP_PROGRAM] },
          { commitment: CONFIG.commitment },
        ],
      }),
    );
  }

  #startPing() {
    this.#clearPing();
    this.#pingTimer = setInterval(() => {
      // JSON-RPC ping keeps intermediate proxies from idling us out; the
      // "unknown method" error reply is fine, it's traffic either way.
      try {
        this.#ws?.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: this.#nextId++,
            method: "ping",
          }),
        );
      } catch {
        /* socket mid-close */
      }
    }, CONFIG.pingIntervalMs);
  }

  #clearPing() {
    if (this.#pingTimer) clearInterval(this.#pingTimer);
    this.#pingTimer = null;
  }

  async #handle(raw: string) {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.method !== "logsNotification") return; // sub confirms, ping errors, etc.

    const { value, context } = msg.params.result as {
      context: { slot: number };
      value: { signature: string; err: unknown; logs: string[] };
    };

    if (value.err !== null) return; // failed create attempts are noise
    if (!looksLikeCreate(value.logs)) return; // skip the buy/sell firehose cheaply
    if (!this.#sigLru.addIfNew(value.signature)) return;

    let ev = this.#decodeFromLogs(value.logs, value.signature, context.slot);

    if (!ev && CONFIG.fallbackFetchTx) {
      // Truncated logs — one targeted round-trip, only for actual creates.
      const logs = await fetchTxLogs(value.signature);
      if (logs) ev = this.#decodeFromLogs(logs, value.signature, context.slot);
    }

    if (!ev) {
      console.warn(
        `[decode] create-looking tx with no CreateEvent: ${value.signature}`,
      );
      return;
    }
    if (!this.#seenMints.has(ev.mint)) {
      this.#seenMints.add(ev.mint);
      this.onToken(ev);
    }
  }

  #decodeFromLogs(
    logs: string[],
    signature: string,
    slot: number,
  ): NewTokenEvent | null {
    for (const data of extractProgramData(logs)) {
      try {
        const ev = decodeCreateEvent(data, { signature, slot });
        if (ev) return ev;
      } catch {
        // valid discriminator but truncated/corrupt body (log truncation) —
        // fall through; the getTransaction fallback will retry with full logs
      }
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const monitor = new PumpMonitor((ev) => {
    const lag =
      ev.timestamp !== undefined
        ? `${ev.detectedAt - Number(ev.timestamp) * 1000}ms`
        : "n/a";
    console.log(
      [
        `\n🚀 ${ev.name} ($${ev.symbol})`,
        `   mint     ${ev.mint}`,
        `   curve    ${ev.bondingCurve}`,
        `   deployer ${ev.creator ?? ev.user}`,
        `   sig      ${ev.signature}`,
        `   slot     ${ev.slot}  lag ${lag}`,
        `   uri      ${ev.uri}`,
      ].join("\n"),
    );
    // downstream hooks go here: telegram notify, auto-subscribe the curve
    // account for case 2 price tracking, snipe evaluation, sqlite insert…
  });

  monitor.start();
  process.on("SIGINT", () => {
    monitor.stop();
    process.exit(0);
  });
}
