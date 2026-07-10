import {
  formatBgrunLifecycleTree,
  listBgrunLifecycleTree,
  stopBgrunLifecycleParent,
  type BgrunLifecycleTreeInput,
} from "../processes/bgrun-tree.js";
import { ensureWorkerGroup } from "../processes/bgrun.js";
import { processMeasure, summarizeForMeasure } from "../measure.js";

export async function inspectProcessTreeAction(
  input: BgrunLifecycleTreeInput & { text?: boolean } = {},
): Promise<Record<string, unknown>> {
  return await processMeasure.measure(
    {
      start: () => "inspect bgrun process tree",
      end: (result) => ({ result: summarizeForMeasure(result) }),
    },
    async () => {
      const tree = await listBgrunLifecycleTree(input);
      return {
        ...tree,
        text: input.text ? formatBgrunLifecycleTree(tree) : undefined,
      };
    },
  );
}

export async function ensureAndInspectProcessTreeAction(
  input: BgrunLifecycleTreeInput & {
    restart?: boolean;
    restartStale?: boolean;
  } = {},
): Promise<Record<string, unknown>> {
  return await processMeasure.measure(
    {
      start: () => "ensure and inspect bgrun process tree",
      end: (result) => ({ result: summarizeForMeasure(result) }),
    },
    async () => {
      const ensure = await ensureWorkerGroup({
        source: input.source,
        telegram: input.telegram,
        restart: input.restart,
        restartStale: input.restartStale,
      });
      const tree = await listBgrunLifecycleTree(input);
      return { ensure, tree, ok: tree.ok };
    },
  );
}

export async function stopProcessTreeAction(
  parent?: string | null,
): Promise<Record<string, unknown>> {
  return await stopBgrunLifecycleParent(parent);
}
