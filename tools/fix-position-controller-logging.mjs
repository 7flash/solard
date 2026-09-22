#!/usr/bin/env node
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const target = resolve(process.argv[2] ?? "examples/position-controller.ts");
const backup = `${target}.before-logging-fix`;
let source = readFileSync(target, "utf8");

const replaceOnce = (from, to, label) => {
  const next = source.replace(from, to);
  if (next === source) throw new Error(`Could not locate ${label}`);
  source = next;
};

source = source.replace(
  /createMeasure\("slrd:value-band-agent", \{ maxResultLength: \d+ \}\)/,
  'createMeasure("slrd:value-band-agent", { maxResultLength: 700 })',
);

replaceOnce(
  /  const note = <T>\(label: string, data: T\): T =>\n    m\.sync\(\n      \{\n        start: \(\) => label,\n        end: \(value: T\) => value,\n      \},\n      \(\) => data,\n    \);/,
  `  const compactNumber = (value: unknown, digits = 7): unknown => {
    if (typeof value !== "number" || !Number.isFinite(value)) return value;
    if (value === 0) return 0;
    return Number(value.toPrecision(digits));
  };

  const compactLog = (label: string, value: unknown): unknown => {
    const v = value as Record<string, any>;
    if (label === "cycle") {
      return {
        action: v.decision?.action,
        positionSol: compactNumber(v.decision?.liquidationSol),
        netCapitalSol: compactNumber(v.netCapitalSol),
        walletSol: compactNumber(v.walletSol),
        cooldownMs: v.cooldownRemainingMs || undefined,
      };
    }
    if (label === "decision") {
      const result: Record<string, unknown> = {
        action: v.action,
        reason: v.reason,
        positionSol: compactNumber(v.liquidationSol),
        priceSol: compactNumber(v.executablePriceSol),
        bandSol: {
          lower: compactNumber(v.lowerSol),
          base: compactNumber(v.baseSol),
          upper: compactNumber(v.upperSol),
        },
      };
      if (v.lastTradeSide != null) result.lastTrade = v.lastTradeSide;
      const next: Record<string, unknown> = {};
      if (v.nextLadderPriceSol != null)
        next.ladderPriceSol = compactNumber(v.nextLadderPriceSol);
      if (v.nextRebuyPriceSol != null)
        next.rebuyPriceSol = compactNumber(v.nextRebuyPriceSol);
      if (v.minTakeProfitPriceSol != null)
        next.takeProfitPriceSol = compactNumber(v.minTakeProfitPriceSol);
      if (Object.keys(next).length > 0) result.next = next;
      if (v.entryPullbackPct > 0 && v.entryCurrentPriceRaw != null) {
        result.entry = {
          priceRaw: compactNumber(v.entryCurrentPriceRaw),
          peakRaw: compactNumber(v.entryPeakPriceRaw),
          triggerRaw: compactNumber(v.entryTriggerPriceRaw),
          pullbackPct: compactNumber(v.entryPullbackPct),
        };
      }
      if (v.netCapitalSol != null || v.maxCapitalSol != null) {
        result.capital = {
          net: compactNumber(v.netCapitalSol),
          max: compactNumber(v.maxCapitalSol),
          maxBuy: compactNumber(v.maxBuySol),
        };
      }
      if (v.cooldownRemainingMs > 0)
        result.cooldownMs = Math.round(v.cooldownRemainingMs);
      if (v.pendingSettlement) {
        result.pending = {
          side: v.pendingSettlement.side,
          venue: v.pendingSettlement.venue,
          signature: v.pendingSettlement.signature,
        };
      }
      return result;
    }
    if (label === "entry.observe") {
      return {
        venue: v.venue,
        probeSol: compactNumber(v.probeSol),
        priceRaw: compactNumber(v.priceRaw),
        peakRaw: compactNumber(v.peakPriceRaw),
        triggerRaw: compactNumber(v.triggerPriceRaw),
        pullbackPct: compactNumber(v.pullbackPctFromPeak),
      };
    }
    if (label.startsWith("settlement.reconcile.")) {
      return {
        settled: v.settled,
        reason: v.reason,
        status: v.signatureStatus,
        signature: v.signature,
      };
    }
    return value;
  };

  const note = <T>(label: string, data: T): T =>
    m.sync(
      {
        start: () => label,
        end: (value: T) => compactLog(label, value),
        maxResultLength: 700,
      },
      () => data,
    );`,
  "note logger",
);

replaceOnce(
  /(start: \(\) => "cycle",\n\s+end: \(value: \{[\s\S]*?walletSol: number;\n\s+\}\) => )value(,)/,
  '$1compactLog("cycle", value)$2',
  "cycle end mapper",
);

source = source.replace(
  /end: \(value: Snapshot\) => \(\{\n\s+tokenRaw: value\.amountRaw\.toString\(\),\n\s+liquidationSol: value\.liquidationSol,\n\s+executablePriceSol: value\.effectivePriceSol,\n\s+walletSol: value\.walletSol,\n\s+venue: value\.quote\?\.venue \?\? null,\n\s+\}\),/g,
  `end: (value: Snapshot) => ({
                  positionSol: compactNumber(value.liquidationSol),
                  priceSol: compactNumber(value.effectivePriceSol),
                  walletSol: compactNumber(value.walletSol),
                  venue: value.quote?.venue ?? null,
                }),`,
);

source = source.replace(
  /end: \(value: Snapshot\) => \(\{\n\s+liquidationSol: value\.liquidationSol,\n\s+executablePriceSol: value\.effectivePriceSol,\n\s+walletSol: value\.walletSol,\n\s+\}\),/g,
  `end: (value: Snapshot) => ({
          positionSol: compactNumber(value.liquidationSol),
          priceSol: compactNumber(value.effectivePriceSol),
          walletSol: compactNumber(value.walletSol),
        }),`,
);

source = source.replace(
  /end: \(value: Snapshot\) => \(\{\n\s+liquidationSol: value\.liquidationSol,\n\s+executablePriceSol: value\.effectivePriceSol,\n\s+\}\),/g,
  `end: (value: Snapshot) => ({
              positionSol: compactNumber(value.liquidationSol),
              priceSol: compactNumber(value.effectivePriceSol),
            }),`,
);

copyFileSync(target, backup);
writeFileSync(target, source);
console.log(`Updated ${target}`);
console.log(`Backup ${backup}`);
