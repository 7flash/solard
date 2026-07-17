import type { AirdropJob } from "./types.js";

type Listener = (job: AirdropJob) => void;

const globalState = globalThis as typeof globalThis & {
  __solardAirdropJobListenersV4?: Map<string, Set<Listener>>;
};

const listeners = (globalState.__solardAirdropJobListenersV4 ??= new Map<
  string,
  Set<Listener>
>());

function clone(job: AirdropJob): AirdropJob {
  return structuredClone(job);
}

export function publishAirdropJob(job: AirdropJob): void {
  const group = listeners.get(job.id);
  if (!group?.size) return;
  const snapshot = clone(job);
  for (const listener of [...group]) {
    try {
      listener(snapshot);
    } catch {
      // A broken client listener must never interrupt job persistence/execution.
    }
  }
}

export function subscribeAirdropJob(
  id: string,
  listener: Listener,
): () => void {
  let group = listeners.get(id);
  if (!group) {
    group = new Set<Listener>();
    listeners.set(id, group);
  }
  group.add(listener);

  return () => {
    const current = listeners.get(id);
    if (!current) return;
    current.delete(listener);
    if (!current.size) listeners.delete(id);
  };
}
