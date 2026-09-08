import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  createSolardMeasureCollector,
  type SolardMeasureEvent,
} from "@solard/sdk";

export type TradingAudit = {
  logPath: string;
  logger: (event: SolardMeasureEvent, next?: () => void) => void;
  event(kind: string, data?: unknown): void;
  measureSummary(): ReturnType<
    ReturnType<typeof createSolardMeasureCollector>["snapshot"]
  >;
};

function json(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    typeof item === "bigint" ? item.toString() : item,
  );
}

function safeName(value: string): string {
  return (
    value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "agent"
  );
}

export function defaultTradingLogPath(name: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return resolve(".solard", "logs", `${safeName(name)}-${stamp}.jsonl`);
}

export function createTradingAudit(logPath: string): TradingAudit {
  const path = resolve(logPath);
  mkdirSync(dirname(path), { recursive: true });
  const collector = createSolardMeasureCollector();
  const write = (row: unknown) =>
    appendFileSync(path, `${json(row)}\n`, "utf8");
  return {
    logPath: path,
    logger(event, _next) {
      collector.logger(event);
      write({ at: new Date().toISOString(), kind: "measure", event });
      // Intentionally do not delegate to measure-fn's terminal formatter. stdout
      // belongs to the dashboard; the JSONL file is the durable diagnostic stream.
    },
    event(kind, data) {
      write({ at: new Date().toISOString(), kind, data });
    },
    measureSummary: () => collector.snapshot(),
  };
}

export type DashboardRow = [label: string, value: string];

export class TradingDashboard {
  private readonly tty: boolean;
  private lastNonTtyAt = 0;
  private cleanupKeys: (() => void) | null = null;

  constructor(
    private readonly title: string,
    private readonly enabled = true,
  ) {
    this.tty = Boolean(enabled && process.stdout.isTTY);
  }

  render(rows: DashboardRow[], footer: string): void {
    if (!this.enabled) return;
    if (!this.tty) {
      const now = Date.now();
      if (now - this.lastNonTtyAt < 30_000) return;
      this.lastNonTtyAt = now;
      const body = rows.map(([k, v]) => `${k}=${v}`).join("  ");
      process.stdout.write(`${this.title}  ${body}\n`);
      return;
    }
    const width = Math.max(68, Math.min(process.stdout.columns || 100, 120));
    const line = "─".repeat(width);
    let out = "\x1b[2J\x1b[H";
    out += `${this.title}\n${line}\n`;
    for (const [label, value] of rows) {
      out += `${label.padEnd(22)} ${value}\n`;
    }
    out += `${line}\n${footer}\n`;
    process.stdout.write(out);
  }

  keys(handlers: {
    plus?: () => void;
    minus?: () => void;
    pause?: () => void;
    rearm?: () => void;
    rebalance?: () => void;
    quit?: () => void;
  }): void {
    if (!this.tty || !process.stdin.isTTY) return;
    const stdin = process.stdin as NodeJS.ReadStream & {
      setRawMode?: (value: boolean) => void;
    };
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk: string | Buffer) => {
      const text = String(chunk);
      for (const key of text) {
        if (key === "+" || key === "=") handlers.plus?.();
        else if (key === "-" || key === "_") handlers.minus?.();
        else if (key === "p" || key === "P") handlers.pause?.();
        else if (key === "r" || key === "R") handlers.rearm?.();
        else if (key === "b" || key === "B") handlers.rebalance?.();
        else if (key === "q" || key === "Q" || key === "\u0003")
          handlers.quit?.();
      }
    };
    stdin.on("data", onData);
    this.cleanupKeys = () => {
      stdin.off("data", onData);
      stdin.setRawMode?.(false);
      stdin.pause();
    };
  }

  close(): void {
    this.cleanupKeys?.();
    this.cleanupKeys = null;
    if (this.tty) process.stdout.write("\x1b[2J\x1b[H");
  }
}

export function fmtSol(value: number | null | undefined, digits = 6): string {
  return value == null || !Number.isFinite(value)
    ? "-"
    : `${value.toFixed(digits)} SOL`;
}

export function fmtPct(value: number | null | undefined, digits = 2): string {
  return value == null || !Number.isFinite(value)
    ? "-"
    : `${value.toFixed(digits)}%`;
}

export function short(value: string, head = 8, tail = 6): string {
  return value.length <= head + tail + 1
    ? value
    : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolvePromise) =>
    setTimeout(resolvePromise, Math.max(0, ms)),
  );
}
