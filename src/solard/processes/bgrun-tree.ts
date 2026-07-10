import { processMeasure, summarizeForMeasure } from "../measure.js";
import bgrun, {
  normalizeBgrunProcess,
  type BgrunProcess,
} from "./bgrun-sdk.js";
import {
  listWorkerRuntimeStatus,
  resolveWorkerNames,
  WORKER_SPECS,
  type SolardWorkerName,
} from "./bgrun.js";

export type BgrunLifecycleWorkerRow = {
  name: SolardWorkerName;
  expected: boolean;
  command: string;
  pid: number;
  alive: boolean;
  registered: boolean;
  childOfParent: boolean;
  parentName: string | null;
  supervisor: string | null;
  status: string;
  stale: boolean;
  ageMs: number;
  buildMismatch: boolean;
  expectedBuildId: string;
  actualBuildId: string | null;
  error: string | null;
  bgrun: Record<string, unknown> | null;
};

export type BgrunLifecycleTree = {
  parentName: string;
  parent: Record<string, unknown> | null;
  parentAlive: boolean;
  expectedWorkers: SolardWorkerName[];
  children: Array<Record<string, unknown>>;
  workers: BgrunLifecycleWorkerRow[];
  problems: string[];
  ok: boolean;
};

export type BgrunLifecycleTreeInput = {
  parent?: string | null;
  source?: string | null;
  telegram?: boolean;
};

function parentName(input?: string | null): string {
  return String(input || process.env.BGR_PROCESS_NAME || "solard");
}

function envValue(
  row: Record<string, unknown> | null,
  key: string,
): string | null {
  const env = row?.env;
  if (!env || typeof env !== "object") return null;
  const value = (env as Record<string, unknown>)[key];
  return typeof value === "string" && value.length ? value : null;
}

function asProcessRow(
  row: BgrunProcess | null | undefined,
): Record<string, unknown> | null {
  return row ? normalizeBgrunProcess(row) : null;
}

async function isAlive(row: Record<string, unknown> | null): Promise<boolean> {
  if (!row) return false;
  const pid = Number(row.pid ?? 0);
  const command = String(row.command ?? "");
  if (!pid) return false;
  return await bgrun.isProcessRunning(pid, command);
}

export async function listBgrunLifecycleTree(
  input: BgrunLifecycleTreeInput = {},
): Promise<BgrunLifecycleTree> {
  return await processMeasure.measure(
    {
      start: () => "bgrun lifecycle tree",
      end: (result) => ({ result: summarizeForMeasure(result) }),
    },
    async () => {
      const parent = parentName(input.parent);
      const parentRow = asProcessRow(bgrun.getProcess(parent));
      const parentAlive = await isAlive(parentRow);
      const children = bgrun
        .getManagedChildProcesses(parent)
        .map(normalizeBgrunProcess);
      const childNames = new Set(children.map((row) => String(row.name ?? "")));
      const expectedWorkers = resolveWorkerNames({
        source: input.source,
        telegram: input.telegram,
      });
      const runtimeRows = new Map(
        listWorkerRuntimeStatus({
          source: input.source,
          telegram: input.telegram,
        }).map((row) => [row.name, row]),
      );
      const problems: string[] = [];

      if (!parentRow && process.env.SOLARD_REQUIRE_BGRUN_PARENT === "1") {
        problems.push(`parent ${parent} is not registered in bgrun`);
      }
      if (parentRow && !parentAlive)
        problems.push(`parent ${parent} is registered but not running`);

      const workers: BgrunLifecycleWorkerRow[] = [];
      for (const name of expectedWorkers) {
        const spec = WORKER_SPECS[name];
        const row = asProcessRow(bgrun.getProcess(name));
        const runtime = runtimeRows.get(name);
        const alive = await isAlive(row);
        const workerParent = envValue(row, "BGR_PARENT_NAME");
        const supervisor =
          envValue(row, "SOLARD_WORKER_SUPERVISOR") ??
          (runtime?.data &&
          typeof (runtime.data as Record<string, unknown>).supervisor ===
            "string"
            ? String((runtime.data as Record<string, unknown>).supervisor)
            : null);
        const childOfParent = childNames.has(name) || workerParent === parent;
        const actualBuildId =
          runtime?.actualBuildId ?? envValue(row, "SOLARD_EXPECTED_BUILD_ID");
        const registered = !!row;
        const stale = runtime?.stale ?? true;
        const buildMismatch =
          runtime?.buildMismatch ??
          (actualBuildId !== null && actualBuildId !== spec.buildId);

        if (!registered) problems.push(`${name} is not registered in bgrun`);
        else if (!alive) problems.push(`${name} is registered but not running`);
        if (registered && !childOfParent)
          problems.push(`${name} is not tagged as child of ${parent}`);
        if (registered && supervisor !== "bgrun-sdk")
          problems.push(`${name} supervisor is ${supervisor || "missing"}`);
        if (buildMismatch)
          problems.push(
            `${name} build mismatch (${actualBuildId || "missing"} != ${spec.buildId})`,
          );
        if (stale) problems.push(`${name} heartbeat is stale`);
        if (runtime?.error) problems.push(`${name} error: ${runtime.error}`);

        workers.push({
          name,
          expected: true,
          command: spec.command,
          pid: Number(row?.pid ?? 0),
          alive,
          registered,
          childOfParent,
          parentName: workerParent,
          supervisor,
          status:
            runtime?.status ??
            (registered ? (alive ? "running" : "stopped") : "missing"),
          stale,
          ageMs: runtime?.ageMs ?? Number.POSITIVE_INFINITY,
          buildMismatch,
          expectedBuildId: spec.buildId,
          actualBuildId,
          error: runtime?.error ?? null,
          bgrun: row,
        });
      }

      return {
        parentName: parent,
        parent: parentRow,
        parentAlive,
        expectedWorkers,
        children,
        workers,
        problems,
        ok: problems.length === 0,
      };
    },
  );
}

export function formatBgrunLifecycleTree(tree: BgrunLifecycleTree): string {
  const lines: string[] = [];
  lines.push(
    `bgrun parent: ${tree.parentName} ${tree.parentAlive ? "running" : tree.parent ? "stopped" : "not-registered"}`,
  );
  lines.push(`children registered: ${tree.children.length}`);
  for (const worker of tree.workers) {
    const age = Number.isFinite(worker.ageMs)
      ? `${Math.round(worker.ageMs)}ms`
      : "never";
    const flags = [
      worker.alive ? "alive" : "dead",
      worker.childOfParent ? "child" : "not-child",
      worker.stale ? "stale" : "fresh",
      worker.buildMismatch ? "build-mismatch" : "build-ok",
    ].join(", ");
    lines.push(
      `- ${worker.name}: ${worker.status} pid=${worker.pid || "-"} age=${age} (${flags})`,
    );
  }
  if (tree.problems.length) {
    lines.push("problems:");
    for (const problem of tree.problems) lines.push(`  - ${problem}`);
  } else {
    lines.push("problems: none");
  }
  return lines.join("\n");
}

export async function stopBgrunLifecycleParent(
  parent?: string | null,
): Promise<Record<string, unknown>> {
  return await processMeasure.measure(
    {
      start: () => "bgrun lifecycle stop parent",
      end: (result) => ({ result: summarizeForMeasure(result) }),
    },
    async () => {
      const name = parentName(parent);
      const before = await listBgrunLifecycleTree({
        parent: name,
        source: "both",
        telegram: true,
      });
      await bgrun.handleStop(name);
      await Bun.sleep(500);
      const after = await listBgrunLifecycleTree({
        parent: name,
        source: "both",
        telegram: true,
      });
      return { parent: name, before, after };
    },
  );
}
