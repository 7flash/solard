import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PumpSwapPoolState } from "./pumpswap-types.js";

type StateFile = {
  version: 2;
  updatedAtMs: number;
  tokens: Record<string, PumpSwapPoolState>;
};

function normalizeState(mint: string, value: any): PumpSwapPoolState | null {
  if (!mint || !value || typeof value !== "object") return null;

  return {
    mint,
    supplyUi: Number(value.supplyUi ?? 0) || 0,
    migrationSlot: Number(value.migrationSlot ?? 0) || 0,

    pool: typeof value.pool === "string" ? value.pool : null,
    quoteMint: typeof value.quoteMint === "string" ? value.quoteMint : null,
    poolBaseTokenAccount:
      typeof value.poolBaseTokenAccount === "string"
        ? value.poolBaseTokenAccount
        : null,
    poolQuoteTokenAccount:
      typeof value.poolQuoteTokenAccount === "string"
        ? value.poolQuoteTokenAccount
        : null,

    lastHistorySlot:
      Number(value.lastHistorySlot ?? value.migrationSlot ?? 0) || 0,
    lastSignature:
      typeof value.lastSignature === "string" ? value.lastSignature : null,
    discoveredAtMs: Number(value.discoveredAtMs ?? 0) || null,
    lastPriceAtMs: Number(value.lastPriceAtMs ?? 0) || null,
    lastHistoryAtMs: Number(value.lastHistoryAtMs ?? 0) || null,
    lastActivityAtMs:
      Number(value.lastActivityAtMs ?? value.lastPriceAtMs ?? 0) || null,
    lastInterestAtMs: Number(value.lastInterestAtMs ?? 0) || null,
    interestScore: Number(value.interestScore ?? 0) || 0,

    discoveryAttempts: Number(value.discoveryAttempts ?? 0) || 0,
    nextDiscoveryAtMs: Number(value.nextDiscoveryAtMs ?? 0) || 0,
    lastError: typeof value.lastError === "string" ? value.lastError : null,
  };
}

export class PumpSwapStateStore {
  private readonly tokens = new Map<string, PumpSwapPoolState>();
  private dirty = false;

  constructor(private readonly path: string) {
    this.load();
  }

  values(): PumpSwapPoolState[] {
    return [...this.tokens.values()];
  }

  get(mint: string): PumpSwapPoolState | undefined {
    return this.tokens.get(mint);
  }

  set(value: PumpSwapPoolState): void {
    this.tokens.set(value.mint, value);
    this.dirty = true;
  }

  delete(mint: string): void {
    if (this.tokens.delete(mint)) this.dirty = true;
  }

  save(): void {
    if (!this.dirty) return;

    mkdirSync(dirname(this.path), { recursive: true });

    const file: StateFile = {
      version: 2,
      updatedAtMs: Date.now(),
      tokens: Object.fromEntries(
        [...this.tokens.entries()].sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
    };

    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    renameSync(temporary, this.path);
    this.dirty = false;
  }

  private load(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as any;
      if (![1, 2].includes(Number(parsed?.version)) || !parsed?.tokens) return;

      for (const [mint, value] of Object.entries(parsed.tokens)) {
        const normalized = normalizeState(mint, value);
        if (normalized) this.tokens.set(mint, normalized);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") {
        console.warn("[solard:pumpswap] state load failed", error);
      }
    }
  }
}
