import { expect, test } from "bun:test";
import { isComputeExhausted, simulationComputeLimit } from "./compute-sizing.ts";
import type { SimulationResult } from "./types.ts";
const result = (values: Partial<SimulationResult>) => ({ success: true, cuUsed: 105_000, error: null, logs: [], ...values } as SimulationResult);
test("compute sizing uses measured usage and bounded margins", () => {
  expect(simulationComputeLimit(result({}))).toBe(136_500);
  expect(simulationComputeLimit(result({}), 1.7)).toBe(178_500);
  expect(() => simulationComputeLimit(result({ cuUsed: null }))).toThrow();
  expect(() => simulationComputeLimit(result({ cuUsed: 1_300_000 }))).toThrow();
  expect(() => simulationComputeLimit(result({}), 2)).toThrow();
});
test("compute retry excludes slippage and generic program errors", () => {
  expect(isComputeExhausted(result({ success: false, error: { InstructionError: [0, "ComputationalBudgetExceeded"] } }))).toBe(true);
  expect(isComputeExhausted(result({ success: false, error: { InstructionError: [0, { Custom: 6042 }] } }))).toBe(false);
});
