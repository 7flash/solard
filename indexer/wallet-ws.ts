import type { WalletIndexerConfig } from "./wallet-config.ts";
import type { WalletIndexerCounters } from "./wallet-types.ts";

type SubscriptionState = {
  id: number;
  key: string;
};

type PendingRequest =
  | { kind: "subscribe"; key: string }
  | { kind: "unsubscribe"; subscriptionId: number };

function walletKey(wallets: readonly string[]): string {
  return wallets.join(",");
}

export class WalletTransactionSubscription {
  private socket: WebSocket | null = null;
  private ready = false;
  private stopped = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private requestId = 20_000;
  private active: SubscriptionState | null = null;
  private readonly pending = new Map<number, PendingRequest>();
  private desiredWallets: string[] = [];
  private desiredKey = "";
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: WalletIndexerConfig,
    private readonly counters: WalletIndexerCounters,
    private readonly onNotification: (message: unknown) => Promise<void> | void,
  ) {}

  start(): void {
    if (this.stopped) return;
    this.ensureConnection();
  }

  setWallets(wallets: readonly string[]): void {
    const normalized = [
      ...new Set(wallets.map((value) => value.trim()).filter(Boolean)),
    ]
      .sort()
      .slice(0, this.config.maxWallets);
    const nextKey = walletKey(normalized);
    if (nextKey === this.desiredKey) return;

    this.desiredWallets = normalized;
    this.desiredKey = nextKey;
    this.counters.enabledWallets = normalized.length;

    if (!normalized.length) {
      if (this.active && this.ready) {
        this.sendUnsubscribe(this.active.id);
        this.active = null;
      }
      return;
    }

    this.ensureConnection();
    this.requestLatestSubscription();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.pending.clear();
    this.active = null;
    const socket = this.socket;
    this.socket = null;
    this.ready = false;
    try {
      socket?.close();
    } catch {}
    this.updateCounters();
  }

  private ensureConnection(): void {
    if (this.stopped || this.socket || !this.desiredWallets.length) {
      return;
    }
    this.connect();
  }

  private connect(): void {
    this.counters.websocketConnecting++;
    const socket = new WebSocket(this.config.wsUrl);
    this.socket = socket;
    this.updateCounters();

    socket.addEventListener("open", () => {
      if (this.stopped || this.socket !== socket) {
        try {
          socket.close();
        } catch {}
        return;
      }
      this.ready = true;
      this.reconnectAttempt = 0;
      this.counters.websocketConnections++;
      this.requestLatestSubscription();
      this.updateCounters();
    });

    socket.addEventListener("message", (event: MessageEvent) => {
      const raw = String(event.data ?? "");
      this.counters.wsBytes += Buffer.byteLength(raw);

      let message: any;
      try {
        message = JSON.parse(raw);
      } catch {
        this.counters.errors++;
        return;
      }

      if (message?.id != null) {
        this.handleResponse(message);
        return;
      }

      if (message?.method !== "transactionNotification") return;
      this.counters.notifications++;
      this.queue = this.queue
        .catch(() => undefined)
        .then(() => this.onNotification(message))
        .catch((error) => {
          this.counters.errors++;
          console.error("[solard:wallet] notification failed", error);
        });
    });

    socket.addEventListener("error", () => {
      try {
        socket.close();
      } catch {}
    });

    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.ready = false;
      this.active = null;
      this.pending.clear();
      this.counters.reconnects++;
      this.scheduleReconnect();
      this.updateCounters();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || !this.desiredWallets.length || this.reconnectTimer) {
      return;
    }
    const delay = Math.min(
      this.config.reconnectMaxMs,
      this.config.reconnectMinMs * 2 ** Math.min(this.reconnectAttempt++, 6),
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureConnection();
    }, delay);
    (this.reconnectTimer as any).unref?.();
  }

  private requestLatestSubscription(): void {
    if (
      this.stopped ||
      !this.ready ||
      !this.socket ||
      !this.desiredWallets.length ||
      this.active?.key === this.desiredKey
    ) {
      return;
    }

    for (const request of this.pending.values()) {
      if (request.kind === "subscribe" && request.key === this.desiredKey) {
        return;
      }
    }

    const id = ++this.requestId;
    this.pending.set(id, { kind: "subscribe", key: this.desiredKey });
    this.counters.subscriptionRequests++;
    this.socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "transactionSubscribe",
        params: [
          {
            failed: false,
            accountInclude: this.desiredWallets,
            tokenAccounts: "balanceChanged",
          },
          {
            commitment: this.config.commitment,
            encoding: "jsonParsed",
            transactionDetails: "full",
            showRewards: false,
            maxSupportedTransactionVersion: 0,
          },
        ],
      }),
    );
    this.updateCounters();
  }

  private handleResponse(message: any): void {
    const id = Number(message.id);
    const request = this.pending.get(id);
    if (!request) return;
    this.pending.delete(id);

    if (request.kind === "unsubscribe") {
      this.updateCounters();
      return;
    }

    if (message.error) {
      this.counters.subscriptionErrors++;
      console.error(
        "[solard:wallet] transactionSubscribe failed",
        message.error,
      );
      this.updateCounters();
      return;
    }

    const subscriptionId = Number(message.result);
    if (!Number.isFinite(subscriptionId) || subscriptionId <= 0) {
      this.counters.subscriptionErrors++;
      this.updateCounters();
      return;
    }

    if (request.key !== this.desiredKey || !this.desiredWallets.length) {
      this.sendUnsubscribe(subscriptionId);
      this.requestLatestSubscription();
      return;
    }

    const previous = this.active;
    this.active = { id: subscriptionId, key: request.key };
    if (previous && previous.id !== subscriptionId) {
      this.sendUnsubscribe(previous.id);
    }
    this.requestLatestSubscription();
    this.updateCounters();
  }

  private sendUnsubscribe(subscriptionId: number): void {
    if (!this.ready || !this.socket || subscriptionId <= 0) return;
    const id = ++this.requestId;
    this.pending.set(id, { kind: "unsubscribe", subscriptionId });
    this.counters.unsubscriptions++;
    this.socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "transactionUnsubscribe",
        params: [subscriptionId],
      }),
    );
    this.updateCounters();
  }

  private updateCounters(): void {
    this.counters.websocketConnecting = this.socket && !this.ready ? 1 : 0;
    this.counters.subscriptions = this.active ? 1 : 0;
  }
}
