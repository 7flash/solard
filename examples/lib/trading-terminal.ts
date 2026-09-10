import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  createSolardMeasureCollector,
  type SolardMeasureEvent,
} from "@solard/sdk";

export type MeasureFileSink = {
  path: string;
  /** measure-fn replacement logger. Built-in formatted output is redirected to path, never stdout. */
  logger: (event: SolardMeasureEvent, next?: () => void) => void;
  summary(): ReturnType<
    ReturnType<typeof createSolardMeasureCollector>["snapshot"]
  >;
};

function safeName(value: string): string {
  return (
    value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "agent"
  );
}

function withoutAnsi(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

export function defaultMeasureLogPath(name: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return resolve(".solard", "logs", `${safeName(name)}-${stamp}.measure.log`);
}

/**
 * Keep measure-fn as the sole logging/instrumentation system.
 *
 * `next()` asks measure-fn to render the exact normal human-readable line. The
 * renderer writes synchronously, so during that one call stdout/stderr are
 * redirected into the file. We do not invent a second JSON event format and we
 * do not let measure-fn fight the interactive dashboard for stdout.
 */
export function createMeasureFileSink(logPath: string): MeasureFileSink {
  const path = resolve(logPath);
  mkdirSync(dirname(path), { recursive: true });
  const collector = createSolardMeasureCollector();

  const append = (chunk: unknown): boolean => {
    const text = Buffer.isBuffer(chunk)
      ? chunk.toString("utf8")
      : String(chunk);
    appendFileSync(path, withoutAnsi(text), "utf8");
    return true;
  };

  return {
    path,
    logger(event, next) {
      collector.logger(event);
      if (!next) return;

      const stdoutWrite = process.stdout.write;
      const stderrWrite = process.stderr.write;
      try {
        process.stdout.write = ((chunk: any) =>
          append(chunk)) as typeof process.stdout.write;
        process.stderr.write = ((chunk: any) =>
          append(chunk)) as typeof process.stderr.write;
        next();
      } finally {
        process.stdout.write = stdoutWrite;
        process.stderr.write = stderrWrite;
      }
    },
    summary: () => collector.snapshot(),
  };
}

export type DashboardRow = [label: string, value: string];

export class TradingDashboard {
  private readonly tty: boolean;
  private lastNonTtyAt = 0;
  private cleanupKeys: (() => void) | null = null;
  private lastFrame = "";
  private alternateScreen = false;

  constructor(
    private readonly title: string,
    private readonly enabled = true,
  ) {
    this.tty = Boolean(enabled && process.stdout.isTTY);
    if (this.tty) {
      // Alternate screen keeps refreshes out of the terminal scrollback. This is
      // the same mechanism used by full-screen TUIs; close() restores the user's
      // original terminal contents.
      process.stdout.write("\x1b[?1049h\x1b[H");
      this.alternateScreen = true;
    }
  }

  render(rows: DashboardRow[], footer: string): void {
    if (!this.enabled) return;
    const width = Math.max(68, Math.min(process.stdout.columns || 100, 120));
    const line = "─".repeat(width);
    let frame = `${this.title}\n${line}\n`;
    for (const [label, value] of rows)
      frame += `${label.padEnd(22)} ${value}\n`;
    frame += `${line}\n${footer}\n`;

    // Avoid repainting when nothing visible changed.
    if (frame === this.lastFrame) return;
    this.lastFrame = frame;

    if (!this.tty) {
      const now = Date.now();
      if (now - this.lastNonTtyAt < 30_000) return;
      this.lastNonTtyAt = now;
      process.stdout.write(frame);
      return;
    }

    process.stdout.write(`\x1b[H\x1b[2J${frame}`);
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
      for (const key of String(chunk)) {
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
    if (this.alternateScreen) {
      process.stdout.write("\x1b[?1049l");
      this.alternateScreen = false;
    }
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
