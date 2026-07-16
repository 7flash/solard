// free-rpc.ts — shared plumbing for free-plan operation.
//
// Two constraints of free RPC tiers, addressed structurally:
//   1. Concurrent WebSocket connections are capped (often at 1) →
//      MuxWs: ONE connection carrying N subscriptions (logsSubscribe,
//      accountSubscribe, …), with subscription-id routing and automatic
//      resubscribe of every registered subscription on reconnect.
//   2. HTTP requests are rate-limited (~10 RPS on typical free tiers) →
//      ThrottledRpc: token-spacing queue, RPS env-configurable, so bursts of
//      getTransaction round-trips queue instead of triggering 429s.

// ---------------------------------------------------------------------------
// throttled HTTP JSON-RPC
// ---------------------------------------------------------------------------

export class ThrottledRpc {
  #id = 1;
  #chain: Promise<void> = Promise.resolve();
  #minGapMs: number;

  constructor(
    private url: string,
    rps: number = Number(process.env.RPC_RPS ?? 8),
  ) {
    this.#minGapMs = Math.ceil(1000 / Math.max(rps, 0.1));
  }

  call<T = any>(method: string, params: unknown[]): Promise<T> {
    // serialize sends with a minimum gap; responses overlap freely
    const slot = this.#chain.then(
      () => new Promise<void>((r) => setTimeout(r, this.#minGapMs)),
    );
    this.#chain = slot;
    return slot.then(async () => {
      const res = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: this.#id++, method, params }),
      });
      if (res.status === 429) throw new Error(`${method}: 429 rate limited (lower RPC_RPS)`);
      const json = (await res.json()) as any;
      if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error)}`);
      return json.result as T;
    });
  }
}

// ---------------------------------------------------------------------------
// multiplexed websocket
// ---------------------------------------------------------------------------

export type NotifyHandler = (result: any) => void;

interface SubSpec {
  key: string; // stable caller key
  method: string; // e.g. "logsSubscribe"
  params: unknown[];
  handler: NotifyHandler;
  subId: number | null; // server-assigned, changes across reconnects
}

const NOTIFICATION_OF: Record<string, string> = {
  logsSubscribe: "logsNotification",
  accountSubscribe: "accountNotification",
  programSubscribe: "programNotification",
  signatureSubscribe: "signatureNotification",
  slotSubscribe: "slotNotification",
};

export class MuxWs {
  #ws: WebSocket | null = null;
  #subs = new Map<string, SubSpec>(); // key → spec
  #pendingReq = new Map<number, string>(); // request id → key
  #bySubId = new Map<number, SubSpec>();
  #id = 1;
  #attempt = 0;
  #ping: ReturnType<typeof setInterval> | null = null;
  #stopped = false;
  onReconnect: (() => void) | null = null;

  constructor(
    private url: string,
    private opts = { pingIntervalMs: 25_000, backoffBaseMs: 500, backoffMaxMs: 20_000 },
  ) {}

  get subscriptionCount() {
    return this.#subs.size;
  }

  start() {
    this.#connect();
  }

  stop() {
    this.#stopped = true;
    if (this.#ping) clearInterval(this.#ping);
    this.#ws?.close();
  }

  /** Register a subscription; survives reconnects until unsubscribed. */
  subscribe(key: string, method: string, params: unknown[], handler: NotifyHandler) {
    if (this.#subs.has(key)) throw new Error(`duplicate subscription key: ${key}`);
    const spec: SubSpec = { key, method, params, handler, subId: null };
    this.#subs.set(key, spec);
    if (this.#ws?.readyState === WebSocket.OPEN) this.#send(spec);
  }

  unsubscribe(key: string) {
    const spec = this.#subs.get(key);
    if (!spec) return;
    this.#subs.delete(key);
    if (spec.subId !== null) {
      this.#bySubId.delete(spec.subId);
      const unsub = spec.method.replace("Subscribe", "Unsubscribe");
      try {
        this.#ws?.send(
          JSON.stringify({ jsonrpc: "2.0", id: this.#id++, method: unsub, params: [spec.subId] }),
        );
      } catch {}
    }
  }

  #send(spec: SubSpec) {
    const id = this.#id++;
    this.#pendingReq.set(id, spec.key);
    this.#ws!.send(
      JSON.stringify({ jsonrpc: "2.0", id, method: spec.method, params: spec.params }),
    );
  }

  #connect() {
    if (this.#stopped) return;
    const ws = new WebSocket(this.url);
    this.#ws = ws;

    ws.onopen = () => {
      this.#attempt = 0;
      this.#bySubId.clear();
      this.#pendingReq.clear();
      for (const spec of this.#subs.values()) {
        spec.subId = null;
        this.#send(spec); // resubscribe everything
      }
      this.#ping = setInterval(() => {
        try {
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: this.#id++, method: "ping" }));
        } catch {}
      }, this.opts.pingIntervalMs);
      console.log(`[mux] open — ${this.#subs.size} subscriptions active`);
    };

    ws.onmessage = (m) => {
      let msg: any;
      try {
        msg = JSON.parse(String(m.data));
      } catch {
        return;
      }
      // subscribe confirmations: {id, result: <subId>}
      if (msg.id !== undefined && this.#pendingReq.has(msg.id)) {
        const key = this.#pendingReq.get(msg.id)!;
        this.#pendingReq.delete(msg.id);
        const spec = this.#subs.get(key);
        if (spec && typeof msg.result === "number") {
          spec.subId = msg.result;
          this.#bySubId.set(msg.result, spec);
        }
        return;
      }
      // notifications: route by params.subscription
      const subId = msg?.params?.subscription;
      if (subId === undefined) return;
      const spec = this.#bySubId.get(subId);
      if (!spec) return;
      if (msg.method && NOTIFICATION_OF[spec.method] && msg.method !== NOTIFICATION_OF[spec.method])
        return; // wrong notification type for this sub — ignore defensively
      spec.handler(msg.params.result);
    };

    ws.onerror = (e) => console.error("[mux] error:", (e as any)?.message ?? e);

    ws.onclose = () => {
      if (this.#ping) clearInterval(this.#ping);
      this.#ping = null;
      if (this.#stopped) return;
      const d = Math.min(this.opts.backoffBaseMs * 2 ** this.#attempt, this.opts.backoffMaxMs);
      const j = d / 2 + Math.random() * (d / 2);
      this.#attempt++;
      console.warn(`[mux] closed — reconnect in ${Math.round(j)}ms (will resubscribe ${this.#subs.size})`);
      setTimeout(() => {
        this.#connect();
        // fire AFTER resubscribes are queued so gap-fill can run in parallel
        this.onReconnect?.();
      }, j);
    };
  }
}
