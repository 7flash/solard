import { describe, expect, test } from "bun:test";
import { measured, measuredSync } from "./measured.ts";

describe("measured adapters", () => {
  test("async returns application value while measuring compact value", async () => {
    let measuredValue: unknown;
    const scope = {
      measure: async (_label: string, fn: () => Promise<unknown>) => {
        measuredValue = await fn();
        return measuredValue;
      },
    };

    const value = await measured(
      scope,
      "operation",
      async () => ({ secret: "not-for-telemetry", count: 3 }),
      (result) => ({ count: result.count }),
    );

    expect(value).toEqual({ secret: "not-for-telemetry", count: 3 });
    expect(measuredValue).toEqual({ count: 3 });
  });

  test("sync supports assert-shaped measure-fn runtimes", () => {
    let measuredValue: unknown;
    const scope = {
      measureSync: Object.assign(() => null, {
        assert: (_label: string, fn: () => unknown) => {
          measuredValue = fn();
          return measuredValue;
        },
      }),
    };

    const value = measuredSync(
      scope,
      "operation",
      () => ({ id: 7, privateValue: "hidden" }),
      (result) => ({ id: result.id }),
    );

    expect(value).toEqual({ id: 7, privateValue: "hidden" });
    expect(measuredValue).toEqual({ id: 7 });
  });
});
