import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import {
  runHistoricalStrategyBatch,
  type AthDipProfitStrategy,
  type HistoricalResearchBatchResult,
  type HistoricalResearchStrategy,
  type HistoricalResearchToken,
} from "@solard/sdk";

type Flags = Map<string, string>;
type Emit = (value: string) => void;

function flag(flags: Flags, key: string): string | undefined {
  const value = flags.get(key);
  return value && value !== "true" ? value : undefined;
}

function numberFlag(
  flags: Flags,
  key: string,
  fallback?: number,
): number | undefined {
  const value = flag(flags, key);
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid --${key}: ${value}`);
  return parsed;
}

function slug(value: string): string {
  return (
    value
      .trim()
      .replace(/\.json$/i, "")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "strategy"
  );
}

function readTokens(pathInput: string): HistoricalResearchToken[] {
  const path = resolve(pathInput);
  const raw = readFileSync(path, "utf8");
  if (extname(path).toLowerCase() === ".json") {
    const parsed = JSON.parse(raw) as unknown;
    const values = Array.isArray(parsed)
      ? parsed
      : (parsed as { tokens?: unknown })?.tokens;
    if (!Array.isArray(values))
      throw new Error(
        `Token JSON must be an array or {"tokens":[...]}: ${path}`,
      );
    return values.map((row) => {
      if (typeof row === "string") return { mint: row };
      if (!row || typeof row !== "object")
        throw new Error(`Invalid token row in ${path}`);
      const value = row as { mint?: unknown; label?: unknown; tags?: unknown };
      if (typeof value.mint !== "string")
        throw new Error(`Token object is missing string mint in ${path}`);
      return {
        mint: value.mint,
        label: typeof value.label === "string" ? value.label : null,
        tags: Array.isArray(value.tags) ? value.tags.map(String) : [],
      };
    });
  }

  return raw
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+#.*$/, "").trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const [mint, label] = line.split(",", 2).map((part) => part.trim());
      if (!mint || mint.toLowerCase() === "mint") return null;
      return { mint, label: label || null } satisfies HistoricalResearchToken;
    })
    .filter((row): row is HistoricalResearchToken => row != null);
}

function readStrategyFile(pathInput: string): HistoricalResearchStrategy {
  const path = resolve(pathInput);
  const strategy = JSON.parse(
    readFileSync(path, "utf8"),
  ) as AthDipProfitStrategy;
  return {
    id: slug(basename(path)),
    strategy,
    source: path,
  };
}

function readStrategies(input: string): HistoricalResearchStrategy[] {
  const direct = resolve(input);
  try {
    if (statSync(direct).isDirectory()) {
      return readdirSync(direct)
        .filter((name) => name.toLowerCase().endsWith(".json"))
        .sort()
        .map((name) => readStrategyFile(join(direct, name)));
    }
    return [readStrategyFile(direct)];
  } catch (error) {
    if (!input.includes(",")) throw error;
    return input
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .map(readStrategyFile);
  }
}

function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return (
    [
      headers.map(csvCell).join(","),
      ...rows.map((row) => headers.map((key) => csvCell(row[key])).join(",")),
    ].join("\n") + "\n"
  );
}

function writeResearchOutput(
  dirInput: string,
  result: HistoricalResearchBatchResult,
): string {
  const dir = resolve(dirInput);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "summary.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  writeFileSync(
    join(dir, "strategy-summary.csv"),
    csv(result.strategies as unknown as Record<string, unknown>[]),
  );
  writeFileSync(
    join(dir, "runs.csv"),
    csv(
      result.runs.map((row) => ({
        mint: row.mint,
        label: row.label,
        tags: row.tags.join("|"),
        strategyId: row.strategyId,
        strategyName: row.strategyName,
        coverage: row.coverage.status,
        sourceRows: row.sourceRows,
        usableRows: row.usableRows,
        periodDays: row.periodDays,
        priceHoldReturnPct: row.priceHoldReturnPct,
        returnPct: row.summary.returnPct,
        excessVsHoldPct: row.excessVsHoldPct,
        maxDrawdownPct: row.summary.maxDrawdownPct,
        finalEquitySol: row.summary.finalEquitySol,
        netPnlSol: row.summary.netPnlSol,
        buys: row.summary.buys,
        sells: row.summary.sells,
        closedLots: row.summary.closedLots,
        openLots: row.summary.openLots,
        winRatePct: row.summary.winRatePct,
      })),
    ),
  );
  writeFileSync(
    join(dir, "skipped-tokens.csv"),
    csv(
      result.skippedTokens.map((row) => ({
        mint: row.mint,
        label: row.label,
        reason: row.reason,
        coverage: row.coverage?.status ?? "unknown",
        sourceRows: row.sourceRows,
        usableRows: row.usableRows,
        periodDays: row.periodDays,
      })),
    ),
  );
  writeFileSync(
    join(dir, "failures.csv"),
    csv(result.failures as unknown as Record<string, unknown>[]),
  );
  return dir;
}

function pct(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function report(result: HistoricalResearchBatchResult): string {
  const lines = [
    "SLRD HISTORICAL STRATEGY RESEARCH",
    `Tokens: ${result.input.tokens} input / ${result.eligibleTokens} eligible / ${result.skippedTokens.length} skipped`,
    `Strategies: ${result.input.strategies}`,
    `Runs: ${result.runs.length} completed / ${result.failures.length} failed`,
    `Capital: ${result.options.startingSol} SOL independently per token`,
    `Filters: minEvents=${result.options.minEvents} minDays=${result.options.minDays} requireFromStart=${result.options.requireFromCreation}`,
    "",
    "RANK  STRATEGY                         MEDIAN    MEAN      PROFITABLE  VS HOLD   MEDIAN DD  TOKENS",
  ];
  for (const row of result.strategies.slice(0, 20)) {
    lines.push(
      `${String(row.rank).padStart(4)}  ${row.strategyId.slice(0, 30).padEnd(30)}  ` +
        `${pct(row.medianReturnPct).padStart(9)}  ${pct(row.meanReturnPct).padStart(9)}  ` +
        `${row.profitableTokenPct.toFixed(0).padStart(9)}%  ${row.outperformHoldPct.toFixed(0).padStart(7)}%  ` +
        `${row.medianMaxDrawdownPct.toFixed(2).padStart(8)}%  ${String(row.completedTokens).padStart(6)}`,
    );
  }
  lines.push(
    "",
    "Ranking is in-sample descriptive research, not a claim that rank #1 will perform best live.",
  );
  return lines.join("\n");
}

export async function runBacktestBatchCommand(args: {
  values: string[];
  flags: Flags;
  emit: Emit;
}): Promise<void> {
  const tokensPath = flag(args.flags, "tokens") ?? args.values[0];
  const strategiesPath = flag(args.flags, "strategies");
  if (!tokensPath || !strategiesPath) {
    throw new Error(
      "Usage: slrd backtest batch --tokens <tokens.txt|json> --strategies <dir|file.json[,file2.json]> " +
        "[--capital-sol 5] [--min-events 100] [--min-days 1] [--require-from-start] [--out <dir>]",
    );
  }

  const tokens = readTokens(tokensPath);
  const strategies = readStrategies(strategiesPath);
  const result = runHistoricalStrategyBatch(tokens, strategies, {
    startingSol: numberFlag(args.flags, "capital-sol", 5),
    includeProcessed: !args.flags.has("confirmed-only"),
    coverageToleranceMs: numberFlag(
      args.flags,
      "coverage-tolerance-ms",
      60_000,
    ),
    requireFromCreation: args.flags.has("require-from-start"),
    minEvents: numberFlag(args.flags, "min-events", 2),
    minDays: numberFlag(args.flags, "min-days", 0),
  });

  const out = flag(args.flags, "out");
  const written = out ? writeResearchOutput(out, result) : null;
  if (args.flags.has("json")) args.emit(`${JSON.stringify(result, null, 2)}\n`);
  else {
    args.emit(`${report(result)}\n`);
    if (written) args.emit(`Research output: ${written}\n`);
  }
}
