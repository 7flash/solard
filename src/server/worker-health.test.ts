import { describe, expect, test } from "bun:test";
import {
  WORKER_HEARTBEAT_TTL_MS,
  workerHeartbeatHealth,
} from "./worker-health.ts";

describe("worker heartbeat health", () => {
  test("missing heartbeat is stale", () => {
    expect(workerHeartbeatHealth(null, 100_000).fresh).toBe(false);
  });

  test("fresh heartbeat stays online inside TTL", () => {
    const now = 100_000;
    expect(
      workerHeartbeatHealth(now - WORKER_HEARTBEAT_TTL_MS + 1, now).fresh,
    ).toBe(true);
  });

  test("heartbeat becomes stale exactly at TTL", () => {
    const now = 100_000;
    expect(
      workerHeartbeatHealth(now - WORKER_HEARTBEAT_TTL_MS, now).fresh,
    ).toBe(false);
  });
});
