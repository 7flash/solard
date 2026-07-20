import { createHash } from "node:crypto";
import {
  getTerminalToken,
  setTerminalTokenMayhem,
  upsertTerminalToken,
} from "../shared/db.js";
import { compactId, dbMeasure, summarizeError } from "../shared/measure.js";
import { applyIndexedEvents } from "./apply.ts";
import type { IndexerConfig } from "./config.ts";
import { parsePumpLogs } from "./pump-events.ts";
import type { Counters, TrackedPumpToken } from "./types.ts";

type Assignment = {
  mint: string;
  account: string;
  token: TrackedPumpToken;
  channelIndex: number;
  requestId: number;
  subscriptionId: number | null;
  cancelled: boolean;
};

type Channel = {
  index: number;
  socket: WebSocket | null;
  ready: boolean;
  connecting: boolean;
  reconnectAttempt: number;
  reconnectAtMs: number;
  assignedMints: Set<string>;
  pending: Map<number, Assignment>;
  subscriptions: Map<number, Assignment>;
  queue: Promise<void>;
};

type RpcAccount = {
  data?: [string, string] | string;
  owner?: string;
} | null;

type CurveSample = {
  priceSol: number;
  marketCapSol: number;
  supplyUi: number;
  complete: boolean;
  isMayhemMode: boolean;
};

const BONDING_CURVE_DISCRIMINATOR = createHash("sha256")
  .update("account:BondingCurve")
  .digest()
  .subarray(0, 8);

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function encodedData(value: RpcAccount): string | null {
  const data = value?.data;
  if (Array.isArray(data) && typeof data[0] === "string") return data[0];
  return typeof data === "string" ? data : null;
}

function decodeCurve(
  encoded: string,
  config: IndexerConfig,
  fallbackSupplyUi: number,
): CurveSample | null {
  const data = Buffer.from(encoded, "base64");
  if (data.length < 49) return null;
  if (!data.subarray(0, 8).equals(BONDING_CURVE_DISCRIMINATOR)) return null;

  // Stable Pump BondingCurve prefix:
  //   0..7   discriminator
  //   8..15  virtual_token_reserves
  //   16..23 virtual_sol_reserves
  //   24..31 real_token_reserves
  //   32..39 real_sol_reserves
  //   40..47 token_total_supply
  //   48     complete
  //   49..80 creator
  //   81     is_mayhem_mode, when present
  const virtualTokenRaw = data.readBigUInt64LE(8);
  const virtualSolRaw = data.readBigUInt64LE(16);
  const totalSupplyRaw = data.readBigUInt64LE(40);

  const virtualTokenUi = Number(virtualTokenRaw) / 10 ** config.tokenDecimals;
  const virtualSolUi = Number(virtualSolRaw) / 1_000_000_000;
  if (!Number.isFinite(virtualTokenUi) || virtualTokenUi <= 0) return null;
  if (!Number.isFinite(virtualSolUi) || virtualSolUi <= 0) return null;

  const priceSol = virtualSolUi / virtualTokenUi;
  if (!Number.isFinite(priceSol) || priceSol <= 0) return null;

  const decodedSupplyUi = Number(totalSupplyRaw) / 10 ** config.tokenDecimals;
  const supplyUi =
    Number.isFinite(decodedSupplyUi) && decodedSupplyUi > 0
      ? decodedSupplyUi
      : fallbackSupplyUi > 0
        ? fallbackSupplyUi
        : config.pumpSupplyUi;

  return {
    priceSol,
    marketCapSol: priceSol * supplyUi,
    supplyUi,
    complete: data[48] === 1,
    isMayhemMode: data.length > 81 && data[81] === 1,
  };
}

function priority(token: TrackedPumpToken): number[] {
  return [token.activityAtMs, token.observedAtMs];
}

function comparePriority(
  left: TrackedPumpToken,
  right: TrackedPumpToken,
): number {
  const a = priority(left);
  const b = priority(right);
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return b[index]! - a[index]!;
  }
  return left.mint.localeCompare(right.mint);
}

/**
 * Tracks only PumpPortal-admitted tokens.
 *
 * - One exact `logsSubscribe` per bonding-curve address, multiplexed over at
 *   most five sockets. This supplies actual trades for VOL/SMA and never
 *   listens to the Pump program globally.
 * - One shared getMultipleAccounts bucket refreshes price/MC every configured
 *   interval and repairs missed websocket events.
 */
export class PumpCurveSubscriptionManager {
  private readonly channels: Channel[] = [];
  private readonly desired = new Map<string, TrackedPumpToken>();
  private readonly assignments = new Map<string, Assignment>();
  private requestId = 1000;
  private maintainTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private signal: AbortSignal | null = null;
  private stopped = false;
  private polling = false;
  private rerunPoll = false;

  constructor(
    private readonly config: IndexerConfig,
    private readonly counters: Counters,
    private readonly onComplete: (mint: string) => void,
  ) {}

  start(signal: AbortSignal): void {
    if (this.maintainTimer || this.pollTimer) return;
    this.signal = signal;
    this.stopped = signal.aborted;
    signal.addEventListener("abort", () => this.stop(), { once: true });

    this.maintainTimer = setInterval(() => this.maintain(), 250);
    (this.maintainTimer as any).unref?.();

    this.pollTimer = setInterval(() => {
      void this.pollNow();
    }, this.config.curvePollMs);
    (this.pollTimer as any).unref?.();

    this.maintain();
  }

  admit(token: TrackedPumpToken): void {
    this.desired.set(token.mint, token);
    this.enforceCapacity();
    this.maintain();
    void this.pollNow();
  }

  reconcile(tokens: readonly TrackedPumpToken[]): void {
    const next = new Map(tokens.map((token) => [token.mint, token] as const));

    for (const [mint] of this.desired) {
      if (!next.has(mint)) {
        this.removeMint(mint);
        this.counters.curveLifecycleEvictions++;
      }
    }

    for (const token of tokens) {
      const assignment = this.assignments.get(token.mint);
      if (assignment && assignment.account !== token.bondingCurveKey) {
        this.removeAssignment(token.mint);
      }
      this.desired.set(token.mint, token);
      if (assignment) assignment.token = token;
    }

    this.enforceCapacity();
    this.maintain();
    void this.pollNow();
    this.updateCounters();
  }

  removeMint(mint: string): void {
    this.desired.delete(mint);
    this.removeAssignment(mint);
    this.updateCounters();
  }

  snapshot(): TrackedPumpToken[] {
    return [...this.desired.values()];
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.maintainTimer) clearInterval(this.maintainTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.maintainTimer = null;
    this.pollTimer = null;

    for (const mint of [...this.assignments.keys()])
      this.removeAssignment(mint);
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
    this.desired.clear();
    this.updateCounters();
  }

  private enforceCapacity(): void {
    const capacity = Math.min(
      this.config.maxTrackedTokens,
      this.config.maxConnections * this.config.maxSubscriptionsPerConnection,
    );
    const ranked = [...this.desired.values()].sort(comparePriority);
    if (ranked.length <= capacity) return;

    for (const token of ranked.slice(capacity)) {
      this.removeMint(token.mint);
      this.counters.curveCapacityEvictions++;
    }
  }

  private maintain(): void {
    if (this.stopped || this.signal?.aborted) return;

    const required =
      this.desired.size === 0
        ? 0
        : Math.min(
            this.config.maxConnections,
            Math.ceil(
              this.desired.size / this.config.maxSubscriptionsPerConnection,
            ),
          );

    while (this.channels.length < required) {
      this.channels.push(this.createChannel(this.channels.length));
    }

    for (let index = 0; index < required; index++) {
      const channel = this.channels[index]!;
      if (
        !channel.ready &&
        !channel.connecting &&
        Date.now() >= channel.reconnectAtMs
      ) {
        this.connect(channel);
      }
    }

    this.allocate();
    this.closeUnused(required);
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
      queue: Promise.resolve(),
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
      this.allocate();
      this.updateCounters();
    });

    socket.addEventListener("message", (event: MessageEvent) => {
      const raw = String(event.data ?? "");
      this.counters.curveWsBytes += Buffer.byteLength(raw);

      let message: any;
      try {
        message = JSON.parse(raw);
      } catch {
        this.counters.errors++;
        return;
      }

      if (message?.id != null) {
        this.handleSubscriptionResponse(channel, message);
        return;
      }

      if (message?.method !== "logsNotification") return;
      const subscriptionId = Number(message?.params?.subscription);
      const assignment = channel.subscriptions.get(subscriptionId);
      if (!assignment || assignment.cancelled) return;

      this.counters.curveNotifications++;
      channel.queue = channel.queue
        .catch(() => undefined)
        .then(() => this.applyLogs(assignment, message))
        .catch((error) => {
          this.counters.errors++;
          console.error("[solard:pump] tracked log failed", error);
        });
    });

    socket.addEventListener("error", () => {
      try {
        socket.close();
      } catch {}
    });
    socket.addEventListener("close", () => {
      if (channel.socket === socket) this.handleClose(channel);
    });
    this.updateCounters();
  }

  private handleSubscriptionResponse(channel: Channel, message: any): void {
    const requestId = Number(message.id);
    const assignment = channel.pending.get(requestId);
    if (!assignment) return; // unsubscribe response or stale response
    channel.pending.delete(requestId);

    if (message.error) {
      channel.assignedMints.delete(assignment.mint);
      if (this.assignments.get(assignment.mint) === assignment) {
        this.assignments.delete(assignment.mint);
      }
      this.counters.curveSubscriptionErrors++;
      console.error(
        `[solard:pump] logsSubscribe failed mint=${compactId(assignment.mint)}`,
        message.error,
      );
      this.updateCounters();
      return;
    }

    const subscriptionId = Number(message.result);
    if (!Number.isFinite(subscriptionId) || subscriptionId <= 0) {
      channel.assignedMints.delete(assignment.mint);
      if (this.assignments.get(assignment.mint) === assignment) {
        this.assignments.delete(assignment.mint);
      }
      this.counters.curveSubscriptionErrors++;
      this.updateCounters();
      return;
    }

    assignment.subscriptionId = subscriptionId;
    if (assignment.cancelled || !this.desired.has(assignment.mint)) {
      this.sendUnsubscribe(channel, subscriptionId);
      channel.assignedMints.delete(assignment.mint);
      return;
    }

    channel.subscriptions.set(subscriptionId, assignment);
    this.updateCounters();
  }

  private handleClose(channel: Channel): void {
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
      this.counters.curveReconnects++;
    }
    this.updateCounters();
  }

  private allocate(): void {
    for (const token of this.desired.values()) {
      if (this.assignments.has(token.mint)) continue;

      const channel = this.channels.find(
        (candidate) =>
          candidate.ready &&
          candidate.assignedMints.size <
            this.config.maxSubscriptionsPerConnection,
      );
      if (!channel) break;

      const assignment: Assignment = {
        mint: token.mint,
        account: token.bondingCurveKey,
        token,
        channelIndex: channel.index,
        requestId: 0,
        subscriptionId: null,
        cancelled: false,
      };
      channel.assignedMints.add(token.mint);
      this.assignments.set(token.mint, assignment);
      this.sendSubscribe(channel, assignment);
    }
    this.updateCounters();
  }

  private sendSubscribe(channel: Channel, assignment: Assignment): void {
    if (!channel.ready || !channel.socket) return;
    const requestId = this.requestId++;
    assignment.requestId = requestId;
    channel.pending.set(requestId, assignment);
    channel.socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
        method: "logsSubscribe",
        params: [
          { mentions: [assignment.account] },
          { commitment: this.config.commitment },
        ],
      }),
    );
    this.counters.curveSubscribeRequests++;
  }

  private removeAssignment(mint: string): void {
    const assignment = this.assignments.get(mint);
    if (!assignment) return;
    assignment.cancelled = true;
    this.assignments.delete(mint);

    const channel = this.channels[assignment.channelIndex];
    if (!channel) return;
    channel.assignedMints.delete(mint);
    if (assignment.subscriptionId != null) {
      channel.subscriptions.delete(assignment.subscriptionId);
      this.sendUnsubscribe(channel, assignment.subscriptionId);
    }
  }

  private sendUnsubscribe(channel: Channel, subscriptionId: number): void {
    if (!channel.ready || !channel.socket) return;
    channel.socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: this.requestId++,
        method: "logsUnsubscribe",
        params: [subscriptionId],
      }),
    );
    this.counters.curveUnsubscriptions++;
  }

  private closeUnused(required: number): void {
    for (let index = this.channels.length - 1; index >= required; index--) {
      const channel = this.channels[index]!;
      if (channel.assignedMints.size > 0) continue;
      try {
        channel.socket?.close();
      } catch {}
      channel.socket = null;
      channel.ready = false;
      channel.connecting = false;
    }
  }

  private async applyLogs(assignment: Assignment, message: any): Promise<void> {
    const result = message?.params?.result;
    const value = result?.value;
    const signature = String(value?.signature ?? "");
    const logs = value?.logs;
    if (!signature || !Array.isArray(logs) || value?.err) return;

    const parsed = parsePumpLogs(
      {
        signature,
        slot: Number(result?.context?.slot ?? 0),
        logs,
        receivedAtMs: Date.now(),
      },
      {
        solUsd: this.counters.solUsd ?? this.config.solUsd,
        tokenDecimals: this.config.tokenDecimals,
        pumpSupplyUi: this.config.pumpSupplyUi,
        programId: this.config.programId,
      },
    );

    this.counters.programDataLines += parsed.diagnostics.programDataLines;
    this.counters.recognizedEventLines +=
      parsed.diagnostics.recognizedEventLines;
    this.counters.unknownEventLines += parsed.diagnostics.unknownEventLines;
    this.counters.eventParseErrors += parsed.diagnostics.parseErrors;
    this.counters.lastUnknownDiscriminator =
      parsed.diagnostics.lastUnknownDiscriminator ??
      this.counters.lastUnknownDiscriminator;
    this.counters.lastProgramDataLength =
      parsed.diagnostics.lastProgramDataLength ??
      this.counters.lastProgramDataLength;

    const events = parsed.events.filter(
      (event) => event.mint === assignment.mint && event.kind !== "create",
    );
    this.counters.parsedTrades += events.filter(
      (event) => event.kind === "trade",
    ).length;
    this.counters.parsedCompletes += events.filter(
      (event) => event.kind === "complete",
    ).length;

    if (!events.length) return;
    await applyIndexedEvents(events, {
      config: this.config,
      counters: this.counters,
    });

    if (events.some((event) => event.kind === "complete")) {
      this.removeMint(assignment.mint);
      this.onComplete(assignment.mint);
    }
  }

  private async pollNow(): Promise<void> {
    if (this.stopped || this.signal?.aborted) return;
    if (this.polling) {
      this.rerunPoll = true;
      return;
    }

    this.polling = true;
    try {
      do {
        this.rerunPoll = false;
        await this.pollOnce();
      } while (this.rerunPoll && !this.stopped && !this.signal?.aborted);
    } catch (error) {
      this.counters.errors++;
      console.error("[solard:pump] curve poll failed", error);
    } finally {
      this.polling = false;
      this.updateCounters();
    }
  }

  private async pollOnce(): Promise<void> {
    const tokens = [...this.desired.values()];
    if (!tokens.length) return;

    for (const batch of chunks(tokens, 100)) {
      if (this.stopped || this.signal?.aborted) return;

      const controller = new AbortController();
      const abort = () => controller.abort();
      this.signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(
        () => controller.abort(),
        this.config.curveRpcTimeoutMs,
      );

      try {
        const response = await fetch(this.config.rpcUrl, {
          method: "POST",
          signal: controller.signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: `pump-curves:${Date.now()}`,
            method: "getMultipleAccounts",
            params: [
              batch.map((token) => token.bondingCurveKey),
              {
                encoding: "base64",
                commitment: this.config.commitment,
                dataSlice: { offset: 0, length: 82 },
              },
            ],
          }),
        });

        if (!response.ok) {
          throw new Error(`getMultipleAccounts HTTP ${response.status}`);
        }

        const payload = (await response.json()) as any;
        if (payload.error) {
          throw new Error(
            payload.error.message ?? JSON.stringify(payload.error),
          );
        }

        const values = payload?.result?.value as RpcAccount[] | undefined;
        if (!Array.isArray(values)) {
          throw new Error("getMultipleAccounts returned no account values");
        }

        const slot = Number(payload?.result?.context?.slot ?? 0);
        this.counters.curveRefreshBatches++;
        this.counters.curveRefreshAccounts += batch.length;

        let updated = 0;
        let unavailable = 0;
        let invalid = 0;

        for (let index = 0; index < batch.length; index++) {
          const token = batch[index]!;
          const account = values[index] ?? null;

          const existing = getTerminalToken(token.mint);
          if (!existing || !this.desired.has(token.mint)) {
            this.removeMint(token.mint);
            continue;
          }

          if (!account) {
            unavailable++;
            continue;
          }
          if (account.owner && account.owner !== this.config.programId) {
            invalid++;
            this.counters.curveSubscriptionErrors++;
            continue;
          }

          const encoded = encodedData(account);
          if (!encoded || !this.applySample(token, encoded, slot)) {
            invalid++;
            continue;
          }
          updated++;
        }

        if (updated === 0 || unavailable > 0 || invalid > 0) {
          console.log(
            `[solard:pump] curve_poll requested=${batch.length} updated=${updated} unavailable=${unavailable} invalid=${invalid} slot=${slot}`,
          );
        }
      } finally {
        clearTimeout(timer);
        this.signal?.removeEventListener("abort", abort);
      }
    }
  }

  private applySample(
    token: TrackedPumpToken,
    encoded: string,
    slot: number,
  ): boolean {
    const sample = decodeCurve(encoded, this.config, token.supplyUi);
    if (!sample) {
      this.counters.curveSubscriptionErrors++;
      return false;
    }

    const existing = getTerminalToken(token.mint);
    if (!existing) {
      this.removeMint(token.mint);
      return false;
    }

    const now = Date.now();
    const solUsd = this.counters.solUsd ?? this.config.solUsd;
    const marketCapUsd =
      solUsd != null && Number.isFinite(solUsd) && solUsd > 0
        ? sample.marketCapSol * solUsd
        : null;

    dbMeasure.sync(
      {
        start: () => `db.curve_price mint=${compactId(token.mint)}`,
        end: (result: any) => ({
          updated: result != null,
          mcapUsd: marketCapUsd,
        }),
        catch: summarizeError,
      },
      () =>
        upsertTerminalToken({
          mint: token.mint,
          bondingCurveKey: token.bondingCurveKey,
          source: "helius-curve-poll",
          phase: sample.complete ? "migrated" : "pump",
          supplyUi: sample.supplyUi,
          priceSol: sample.priceSol,
          priceUsd: solUsd != null ? sample.priceSol * solUsd : null,
          marketCapSol: sample.marketCapSol,
          marketCapUsd,
          lastSlot: slot > 0 ? slot : undefined,
          priceUpdatedAtMs: now,
          updatedAtMs: now,
        }),
    );

    setTerminalTokenMayhem({
      mint: token.mint,
      isMayhemMode: sample.isMayhemMode,
      checkedAtMs: now,
    });

    this.counters.mayhemChecked++;
    if (sample.isMayhemMode) this.counters.mayhemDetected++;
    this.counters.curvePriceUpdates++;
    this.counters.lastMint = token.mint;
    this.counters.lastMcapUsd = marketCapUsd ?? this.counters.lastMcapUsd;
    this.counters.lastEventAtMs = now;

    if (sample.complete) {
      this.counters.curveCompleteUpdates++;
      this.removeMint(token.mint);
      this.onComplete(token.mint);
    }
    return true;
  }

  private updateCounters(): void {
    this.counters.curveConnections = this.channels.filter(
      (channel) => channel.ready,
    ).length;
    this.counters.curveConnecting = this.channels.filter(
      (channel) => channel.connecting,
    ).length;
    this.counters.curveSubscriptions = this.channels.reduce(
      (sum, channel) => sum + channel.subscriptions.size,
      0,
    );
    this.counters.curvePendingSubscriptions = this.channels.reduce(
      (sum, channel) => sum + channel.pending.size,
      0,
    );
  }
}
