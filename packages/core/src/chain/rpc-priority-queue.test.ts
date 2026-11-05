import { expect, test } from "bun:test";
import { RpcScheduler } from "./rpc-scheduler.ts";
import { withTradeRpcPriority } from "./rpc-priority.ts";

test("trade requests jump ahead of queued background reads", async () => {
  const url = "https://priority-test.example/rpc";
  process.env.SLRD_RPC_PROVIDER_LIMITS = JSON.stringify({ "priority-test.example": { group: "prio-test", rps: 1000, concurrency: 1 } });
  delete process.env.SLRD_RPC_TRADE_PRIORITY;
  const scheduler = new RpcScheduler(), order: string[] = [];
  const first = await scheduler.acquire(url, 1, 0);                       // holds the only slot
  const background = Array.from({ length: 3 }, (_, i) =>
    scheduler.acquire(url, 1, 0).then(p => { order.push(`bg${i}`); p.release(); }));
  await Bun.sleep(30);                                                     // background reads are queued
  const trade = withTradeRpcPriority(() => scheduler.acquire(url, 1, 0)).then(p => { order.push("trade"); p.release(); });
  await Bun.sleep(30);
  first.release();
  await Promise.all([trade, ...background]);
  expect(order[0]).toBe("trade");
  expect(order.slice(1)).toEqual(["bg0", "bg1", "bg2"]);
});
