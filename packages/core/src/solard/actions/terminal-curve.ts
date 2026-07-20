import { measureSolard } from "../api-response.ts";
import { refreshTerminalCurveSnapshots } from "../helius/curve-snapshot.ts";

export async function refreshTerminalCurvesAction(
  input: {
    source?: string | null;
    limit?: number;
    activeWindowMs?: number;
  } = {},
) {
  return await measureSolard(
    "solard:action:terminal:curve",
    "refresh curve snapshots",
    async () => await refreshTerminalCurveSnapshots(input),
    {
      result: (value) => ({
        updated: value.updated,
        checked: value.checked,
        missing: value.missing,
        errors: value.errors,
      }),
    },
  );
}
