import { expect, test } from "bun:test";
import { SampleWake } from "./sample-wake.ts";

test("a fresh sample wakes a waiting decision before the five-second tick", async () => {
  const wake = new SampleWake();
  let completed = false;
  const decision = wake.after(0, 5000).then(() => { completed = true; });
  wake.notify();
  await decision;
  expect(completed).toBe(true);
  expect(wake.version).toBe(1);
});

test("sample arriving during trade work is consumed without another interval", async () => {
  const wake = new SampleWake();
  const observed = wake.version;
  wake.notify();
  const result = await Promise.race([wake.after(observed, 5000).then(() => "fresh"), Bun.sleep(20).then(() => "late")]);
  expect(result).toBe("fresh");
});

test("with no new sample the bounded timer still permits reconciliation", async () => {
  const wake = new SampleWake();
  await wake.after(wake.version, 1);
  wake.notify();
  await wake.after(0, 5000);
  expect(wake.version).toBe(1);
});
