import {
  USDC_MINT,
  WSOL_MINT,
  type PumpSwapConfig,
} from "./pumpswap-config.js";
import { getTokenAccountAmounts, SolUsdOracle } from "./pumpswap-rpc.js";
import type {
  PumpSwapCounters,
  PumpSwapPoolState,
  PumpSwapReserveSample,
} from "./pumpswap-types.js";

type Assignment = {
  mint: string;
  account: string;
  state: PumpSwapPoolState;
  channelIndex: number;
  requestId: number;
  subscriptionId: number | null;
  useDataSlice: boolean;
  cancelled: boolean;
};

type Channel = {
  index: number;
  socket: any | null;
  ready: boolean;
  connecting: boolean;
  reconnectAttempt: number;
  reconnectAtMs: number;
  assignedMints: Set<string>;
  pending: Map<number, Assignment>;
  subscriptions: Map<number, Assignment>;
};

type DirtyEntry = {
  state: PumpSwapPoolState;
  baseRaw: bigint | null;
  slot: number;
};

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

async function mapWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  work: (value: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const worker = async () => {
    while (index < values.length) {
      const value = values[index++];
      if (value !== undefined) await work(value);
    }
  };

  await Promise.all(
    Array.from(
      {
        length: Math.min(Math.max(1, concurrency), Math.max(1, values.length)),
      },
      worker,
    ),
  );
}

function parseAccountAmount(message: any): bigint | null {
  const data = message?.params?.result?.value?.data;
  const base64 = Array.isArray(data) ? data[0] : data;
  if (typeof base64 !== "string") return null;

  const bytes = Buffer.from(base64, "base64");
  if (bytes.length === 8) return bytes.readBigUInt64LE(0);
  if (bytes.length >= 72) return bytes.readBigUInt64LE(64);
  return null;
}

function uiAmount(value: bigint, decimals: number): number {
  return Number(value) / 10 ** decimals;
}

function isReadyPool(state: PumpSwapPoolState): boolean {
  return Boolean(
    state.pool &&
    state.quoteMint &&
    state.poolBaseTokenAccount &&
    state.poolQuoteTokenAccount,
  );
}

function statePriority(state: PumpSwapPoolState): number[] {
  return [
    Number(state.interestScore || 0),
    Number(state.lastInterestAtMs || 0),
    Number(state.lastActivityAtMs || 0),
    Number(state.discoveredAtMs || 0),
    Number(state.migrationSlot || 0),
  ];
}

function compareStatePriority(
  left: PumpSwapPoolState,
  right: PumpSwapPoolState,
): number {
  const a = statePriority(left);
  const b = statePriority(right);
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return b[index]! - a[index]!;
  }
  return left.mint.localeCompare(right.mint);
}

export class PumpSwapSubscriptionManager {
  private readonly channels: Channel[] = [];
  private readonly desired = new Map<string, PumpSwapPoolState>();
  private readonly assignments = new Map<string, Assignment>();
  private readonly dirty = new Map<string, DirtyEntry>();

  private requestId = 10_000;
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  private signal: AbortSignal | null = null;
  private stopped = false;
  private flushing = false;
  private nextFlushAtMs = 0;
  private nextRepairAtMs = 0;

  constructor(
    private readonly config: PumpSwapConfig,
    private readonly counters: PumpSwapCounters,
    private readonly solUsd: SolUsdOracle,
    private readonly onSample: (
      sample: PumpSwapReserveSample,
    ) => Promise<void> | void,
    private readonly onStateChange: (state: PumpSwapPoolState) => void,
  ) {}

  start(signal: AbortSignal): void {
    if (this.maintenanceTimer) return;

    this.signal = signal;
    this.stopped = signal.aborted;
    signal.addEventListener("abort", () => this.stop(), { once: true });

    this.nextFlushAtMs = Date.now() + this.config.subscriptionFlushMs;
    this.nextRepairAtMs = Date.now();

    this.maintenanceTimer = setInterval(
      () => {
        void this.maintain().catch((error) => {
          this.counters.errors++;
          console.error(
            "[solard:pumpswap] subscription maintenance failed",
            error,
          );
        });
      },
      Math.min(250, this.config.subscriptionFlushMs),
    );
    (this.maintenanceTimer as any).unref?.();

    void this.maintain();
  }

  reconcile(states: readonly PumpSwapPoolState[]): void {
    const capacity =
      this.config.maxConnections * this.config.maxSubscriptionsPerConnection;
    const ranked = states.filter(isReadyPool).sort(compareStatePriority);

    if (ranked.length > capacity) {
      this.counters.capacityEvictions += ranked.length - capacity;
    }

    const next = new Map(
      ranked.slice(0, capacity).map((state) => [state.mint, state] as const),
    );

    for (const [mint, assignment] of this.assignments) {
      const state = next.get(mint);
      if (!state || state.poolBaseTokenAccount !== assignment.account) {
        this.removeAssignment(mint);
      }
    }

    this.desired.clear();
    for (const [mint, state] of next) {
      this.desired.set(mint, state);
      const assignment = this.assignments.get(mint);
      if (assignment) {
        assignment.state = state;
      } else {
        this.markDirty(state, null, 0);
      }
    }

    for (const mint of [...this.dirty.keys()]) {
      if (!this.desired.has(mint)) this.dirty.delete(mint);
    }

    this.updateCounters();
    void this.maintain();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;

    if (this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer);
      this.maintenanceTimer = null;
    }

    for (const mint of [...this.assignments.keys()]) {
      this.removeAssignment(mint);
    }

    for (const channel of this.channels) {
      try {
        channel.socket?.close();
      } catch {}
      channel.socket = null;
      channel.ready = false;
      channel.connecting = false;
      channel.pending.clear();
      channel.subscriptions.clear();
      channel.assignedMints.clear();
    }

    this.dirty.clear();
    this.updateCounters();
  }

  private async maintain(): Promise<void> {
    if (this.stopped || this.signal?.aborted) return;

    const requiredConnections =
      this.desired.size === 0
        ? 0
        : Math.min(
            this.config.maxConnections,
            Math.ceil(
              this.desired.size / this.config.maxSubscriptionsPerConnection,
            ),
          );

    while (this.channels.length < requiredConnections) {
      this.channels.push(this.createChannel(this.channels.length));
    }

    for (let index = 0; index < requiredConnections; index++) {
      const channel = this.channels[index]!;
      if (
        !channel.ready &&
        !channel.connecting &&
        Date.now() >= channel.reconnectAtMs
      ) {
        this.connect(channel);
      }
    }

    this.allocateSubscriptions();

    const now = Date.now();
    if (now >= this.nextRepairAtMs) {
      for (const state of this.desired.values()) {
        this.markDirty(state, null, 0);
      }
      this.nextRepairAtMs = now + this.config.repairPollMs;
    }

    if (now >= this.nextFlushAtMs && !this.flushing) {
      this.nextFlushAtMs = now + this.config.subscriptionFlushMs;
      await this.flushDirty();
    }

    this.closeUnusedChannels(requiredConnections);
    this.updateCounters();
  }

  private createChannel(index: number): Channel {
    return {
      index,
      socket: null,
      ready: false,
      connecting: false,
      reconnectAttempt: 0,
      reconnectAtMs: 0,
      assignedMints: new Set(),
      pending: new Map(),
      subscriptions: new Map(),
    };
  }

  private connect(channel: Channel): void {
    channel.connecting = true;

    const socket = new WebSocket(this.config.wsUrl);
    channel.socket = socket;

    socket.addEventListener("open", () => {
      if (this.stopped || channel.socket !== socket) {
        try {
          socket.close();
        } catch {}
        return;
      }

      channel.ready = true;
      channel.connecting = false;
      channel.reconnectAttempt = 0;
      channel.reconnectAtMs = 0;
      this.updateCounters();
      this.allocateSubscriptions();
    });

    socket.addEventListener("message", (event: any) => {
      const raw = String(event.data ?? "");
      this.counters.wsBytes += Buffer.byteLength(raw);

      let message: any;
      try {
        message = JSON.parse(raw);
      } catch {
        this.counters.errors++;
        return;
      }

      this.handleMessage(channel, message);
    });

    socket.addEventListener("error", () => {
      try {
        socket.close();
      } catch {}
    });

    socket.addEventListener("close", () => {
      if (channel.socket !== socket) return;
      this.handleChannelClose(channel);
    });

    this.updateCounters();
  }

  private handleChannelClose(channel: Channel): void {
    channel.socket = null;
    channel.ready = false;
    channel.connecting = false;

    const affected = [
      ...channel.pending.values(),
      ...channel.subscriptions.values(),
    ];

    channel.pending.clear();
    channel.subscriptions.clear();
    channel.assignedMints.clear();

    for (const assignment of affected) {
      if (this.assignments.get(assignment.mint) === assignment) {
        this.assignments.delete(assignment.mint);
      }
    }

    if (!this.stopped) {
      channel.reconnectAttempt++;
      channel.reconnectAtMs =
        Date.now() +
        Math.min(
          this.config.reconnectMaxMs,
          this.config.reconnectMinMs *
            2 ** Math.min(channel.reconnectAttempt - 1, 6),
        );
      this.counters.reconnects++;
    }

    this.updateCounters();
  }

  private handleMessage(channel: Channel, message: any): void {
    if (message?.id != null) {
      const requestId = Number(message.id);
      const assignment = channel.pending.get(requestId);
      if (!assignment) return;

      channel.pending.delete(requestId);

      if (message.error) {
        if (!assignment.cancelled && assignment.useDataSlice) {
          assignment.useDataSlice = false;
          this.sendSubscribe(channel, assignment);
          return;
        }

        channel.assignedMints.delete(assignment.mint);
        if (this.assignments.get(assignment.mint) === assignment) {
          this.assignments.delete(assignment.mint);
        }
        this.counters.subscriptionErrors++;
        this.updateCounters();
        return;
      }

      const subscriptionId = Number(message.result);
      if (!Number.isFinite(subscriptionId) || subscriptionId <= 0) {
        channel.assignedMints.delete(assignment.mint);
        this.assignments.delete(assignment.mint);
        this.counters.subscriptionErrors++;
        return;
      }

      assignment.subscriptionId = subscriptionId;
      channel.subscriptions.set(subscriptionId, assignment);

      if (assignment.cancelled || !this.desired.has(assignment.mint)) {
        this.sendUnsubscribe(channel, subscriptionId);
        channel.subscriptions.delete(subscriptionId);
        channel.assignedMints.delete(assignment.mint);
      } else {
        this.markDirty(assignment.state, null, 0);
      }

      this.updateCounters();
      return;
    }

    if (message?.method !== "accountNotification") return;

    const subscriptionId = Number(message?.params?.subscription);
    const assignment = channel.subscriptions.get(subscriptionId);
    if (!assignment || assignment.cancelled) return;

    const state = this.desired.get(assignment.mint);
    if (!state) {
      this.removeAssignment(assignment.mint);
      return;
    }

    this.counters.notifications++;

    const baseRaw = parseAccountAmount(message);
    const slot = Number(message?.params?.result?.context?.slot ?? 0) || 0;
    const now = Date.now();

    state.lastActivityAtMs = now;
    assignment.state = state;
    this.onStateChange(state);
    this.markDirty(state, baseRaw, slot);
  }

  private allocateSubscriptions(): void {
    if (this.stopped) return;

    for (const state of this.desired.values()) {
      if (this.assignments.has(state.mint)) continue;
      const account = state.poolBaseTokenAccount;
      if (!account) continue;

      const channel = this.channels.find(
        (candidate) =>
          candidate.ready &&
          candidate.assignedMints.size <
            this.config.maxSubscriptionsPerConnection,
      );
      if (!channel) break;

      const assignment: Assignment = {
        mint: state.mint,
        account,
        state,
        channelIndex: channel.index,
        requestId: 0,
        subscriptionId: null,
        useDataSlice: true,
        cancelled: false,
      };

      this.assignments.set(state.mint, assignment);
      channel.assignedMints.add(state.mint);
      this.sendSubscribe(channel, assignment);
    }

    this.updateCounters();
  }

  private sendSubscribe(channel: Channel, assignment: Assignment): void {
    const socket = channel.socket;
    if (!channel.ready || !socket || socket.readyState !== 1) {
      channel.assignedMints.delete(assignment.mint);
      this.assignments.delete(assignment.mint);
      return;
    }

    const requestId = ++this.requestId;
    assignment.requestId = requestId;
    channel.pending.set(requestId, assignment);

    const accountConfig: Record<string, unknown> = {
      encoding: "base64",
      commitment: this.config.wsCommitment,
    };
    if (assignment.useDataSlice) {
      accountConfig.dataSlice = { offset: 64, length: 8 };
    }

    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
        method: "accountSubscribe",
        params: [assignment.account, accountConfig],
      }),
    );
    this.counters.subscribeRequests++;
  }

  private removeAssignment(mint: string): void {
    const assignment = this.assignments.get(mint);
    if (!assignment) return;

    assignment.cancelled = true;
    this.assignments.delete(mint);
    this.dirty.delete(mint);

    const channel = this.channels[assignment.channelIndex];
    if (!channel) return;

    channel.assignedMints.delete(mint);

    if (assignment.subscriptionId != null) {
      channel.subscriptions.delete(assignment.subscriptionId);
      this.sendUnsubscribe(channel, assignment.subscriptionId);
    }

    this.updateCounters();
  }

  private sendUnsubscribe(channel: Channel, subscriptionId: number): void {
    const socket = channel.socket;
    if (!channel.ready || !socket || socket.readyState !== 1) return;

    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: ++this.requestId,
        method: "accountUnsubscribe",
        params: [subscriptionId],
      }),
    );
    this.counters.unsubscriptions++;
  }

  private markDirty(
    state: PumpSwapPoolState,
    baseRaw: bigint | null,
    slot: number,
  ): void {
    if (!this.desired.has(state.mint)) return;

    const existing = this.dirty.get(state.mint);
    this.dirty.set(state.mint, {
      state,
      baseRaw: baseRaw ?? existing?.baseRaw ?? null,
      slot: Math.max(slot, existing?.slot ?? 0),
    });
    this.counters.dirtyTokens = this.dirty.size;
  }

  private async flushDirty(): Promise<void> {
    if (this.flushing || this.dirty.size === 0) return;
    this.flushing = true;

    const entries = [...this.dirty.values()].filter((entry) =>
      this.desired.has(entry.state.mint),
    );
    this.dirty.clear();
    this.counters.dirtyTokens = 0;

    try {
      const addresses = [
        ...new Set(
          entries.flatMap((entry) => {
            const values = [entry.state.poolQuoteTokenAccount!];
            if (entry.baseRaw == null) {
              values.push(entry.state.poolBaseTokenAccount!);
            }
            return values;
          }),
        ),
      ];
      const amounts = new Map<string, bigint | null>();
      let maxSlot = 0;

      await mapWithConcurrency(
        chunks(addresses, 100),
        this.config.rpcConcurrency,
        async (batch) => {
          this.counters.accountBatches++;
          this.counters.accountsRequested += batch.length;

          const result = await getTokenAccountAmounts(this.config, batch);
          maxSlot = Math.max(maxSlot, result.slot);

          for (let index = 0; index < batch.length; index++) {
            amounts.set(batch[index]!, result.amounts[index] ?? null);
          }
        },
      );

      const currentSolUsd = await this.solUsd.get();
      this.counters.solUsd = currentSolUsd;
      this.counters.solUsdAtMs = Date.now();

      for (const entry of entries) {
        const state = this.desired.get(entry.state.mint);
        if (!state || !state.quoteMint) continue;

        const baseRaw =
          entry.baseRaw ?? amounts.get(state.poolBaseTokenAccount!) ?? null;
        const quoteRaw = amounts.get(state.poolQuoteTokenAccount!) ?? null;

        if (
          baseRaw == null ||
          quoteRaw == null ||
          baseRaw <= 0n ||
          quoteRaw <= 0n
        ) {
          this.counters.invalidReserves++;
          continue;
        }

        const baseUi = uiAmount(baseRaw, this.config.tokenDecimals);
        const quoteDecimals = state.quoteMint === WSOL_MINT ? 9 : 6;
        const quoteUi = uiAmount(quoteRaw, quoteDecimals);

        if (
          !Number.isFinite(baseUi) ||
          !Number.isFinite(quoteUi) ||
          baseUi <= 0 ||
          quoteUi <= 0
        ) {
          this.counters.invalidReserves++;
          continue;
        }

        let priceSol: number | null = null;
        let priceUsd: number | null = null;

        if (state.quoteMint === WSOL_MINT) {
          priceSol = quoteUi / baseUi;
          priceUsd = currentSolUsd != null ? priceSol * currentSolUsd : null;
        } else if (state.quoteMint === USDC_MINT) {
          priceUsd = quoteUi / baseUi;
          priceSol = currentSolUsd != null ? priceUsd / currentSolUsd : null;
        } else {
          this.counters.unsupportedQuotes++;
          continue;
        }

        const marketCapSol =
          priceSol != null && state.supplyUi > 0
            ? priceSol * state.supplyUi
            : null;
        const marketCapUsd =
          priceUsd != null && state.supplyUi > 0
            ? priceUsd * state.supplyUi
            : null;

        await this.onSample({
          state,
          slot: Math.max(entry.slot, maxSlot),
          baseRaw,
          quoteRaw,
          priceSol,
          priceUsd,
          marketCapSol,
          marketCapUsd,
          sampledAtMs: Date.now(),
        });
      }
    } catch (error) {
      this.counters.errors++;
      for (const entry of entries) {
        if (this.desired.has(entry.state.mint)) {
          this.markDirty(entry.state, entry.baseRaw, entry.slot);
        }
      }
      console.error("[solard:pumpswap] reserve refresh failed", error);
    } finally {
      this.flushing = false;
    }
  }

  private closeUnusedChannels(requiredConnections: number): void {
    for (
      let index = requiredConnections;
      index < this.channels.length;
      index++
    ) {
      const channel = this.channels[index]!;
      if (channel.assignedMints.size !== 0 || channel.pending.size !== 0)
        continue;
      if (!channel.socket) continue;

      const socket = channel.socket;
      channel.socket = null;
      channel.ready = false;
      channel.connecting = false;
      try {
        socket.close();
      } catch {}
    }
  }

  private updateCounters(): void {
    this.counters.websocketConnections = this.channels.filter(
      (channel) => channel.ready,
    ).length;
    this.counters.websocketConnecting = this.channels.filter(
      (channel) => channel.connecting,
    ).length;
    this.counters.subscriptions = this.channels.reduce(
      (total, channel) => total + channel.subscriptions.size,
      0,
    );
    this.counters.pendingSubscriptions = this.channels.reduce(
      (total, channel) => total + channel.pending.size,
      0,
    );
    this.counters.dirtyTokens = this.dirty.size;
  }
}
