import { describe, expect, test } from "bun:test";

import {
  createSolardMeasure,
  createSolardMeasureCollector,
  measure,
} from "./log.ts";

describe("Solard measurement surface", () => {
  test("keeps the legacy scope factory as an alias", () => {
    expect(measure).toBe(createSolardMeasure);
  });

  test("rejects empty scope names", () => {
    expect(() => createSolardMeasure("   ")).toThrow(
      "Solard measure scope is required",
    );
  });

  test("collector aggregates, sorts and resets deterministically", () => {
    const collector = createSolardMeasureCollector();

    collector.logger({ type: "success", label: "fast", duration: 2 });
    collector.logger({ type: "error", label: "slow", duration: 7 });
    collector.logger({ type: "success", label: "slow", duration: 5 });
    collector.logger({ type: "annotation", label: "note" });

    expect(collector.snapshot()).toEqual({
      completed: 3,
      successes: 2,
      errors: 1,
      annotations: 1,
      measuredMs: 14,
      maxMs: 7,
      labels: [
        {
          label: "slow",
          calls: 2,
          successes: 1,
          errors: 1,
          totalMs: 12,
          maxMs: 7,
        },
        {
          label: "fast",
          calls: 1,
          successes: 1,
          errors: 0,
          totalMs: 2,
          maxMs: 2,
        },
      ],
    });

    collector.reset();
    expect(collector.snapshot().completed).toBe(0);
    expect(collector.snapshot().labels).toEqual([]);
  });
});
