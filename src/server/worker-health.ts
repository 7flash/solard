export const WORKER_HEARTBEAT_TTL_MS = Math.max(
  3_000,
  Number(process.env.PUMPTV_WORKER_HEARTBEAT_TTL_MS || 8_000),
);

export const WORKER_START_GRACE_MS = Math.max(
  WORKER_HEARTBEAT_TTL_MS,
  Number(process.env.PUMPTV_WORKER_START_GRACE_MS || 12_000),
);

export function workerHeartbeatHealth(
  heartbeatAtMs: number | null | undefined,
  now = Date.now(),
) {
  const heartbeat = Math.max(0, Number(heartbeatAtMs || 0));
  const ageMs =
    heartbeat > 0 ? Math.max(0, now - heartbeat) : Number.POSITIVE_INFINITY;
  return {
    heartbeatAtMs: heartbeat || null,
    ageMs,
    fresh: heartbeat > 0 && ageMs < WORKER_HEARTBEAT_TTL_MS,
  };
}
