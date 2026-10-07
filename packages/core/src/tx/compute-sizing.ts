import type { SimulationResult } from "./types.ts";

export function isComputeExhausted(result: SimulationResult): boolean {
  return !result.success && /ComputationalBudgetExceeded|ProgramFailedToComplete|exceeded.*(?:compute|CUs)|compute.*exceeded/i.test(
    JSON.stringify(result.error) + " " + result.logs.join("\n"),
  );
}

export function simulationComputeLimit(result: SimulationResult, multiplier = 1.3): number {
  if (!Number.isFinite(multiplier) || multiplier < 1.2 || multiplier > 1.7)
    throw new Error("landing.computeUnitMultiplier must be between 1.2 and 1.7");
  if (!result.success || !Number.isSafeInteger(result.cuUsed) || result.cuUsed! <= 0)
    throw new Error("Successful simulation with compute usage is required for automatic compute sizing");
  const units = Math.ceil(result.cuUsed! * multiplier);
  if (units > 1_400_000) throw new Error("Simulation compute margin exceeds the cluster compute limit");
  return units;
}
