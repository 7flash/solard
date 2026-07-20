import { createMeasure, summarizeForMeasure } from "../measure.ts";
import {
  listProjectedSignals,
  projectSignalToTerminal,
  type TerminalSignalProjectionInput,
} from "../signals/terminal-projection.ts";

const actionMeasure = createMeasure("solard:action:signals");

export function listTerminalSignalsAction(
  input: { limit?: number } = {},
): Record<string, unknown> {
  return actionMeasure.measureSync(
    {
      start: () => "list terminal signals",
      end: (result) => ({ result: summarizeForMeasure(result) }),
    },
    () => ({ signals: listProjectedSignals(input.limit ?? 100) }),
  );
}

export async function projectTerminalSignalAction(
  input: TerminalSignalProjectionInput,
): Promise<Record<string, unknown>> {
  return await actionMeasure.measure(
    {
      start: () => "project terminal signal",
      end: (result) => ({ result: summarizeForMeasure(result) }),
    },
    () => projectSignalToTerminal(input),
  );
}
