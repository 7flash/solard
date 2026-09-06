import { describe, expect, test } from "bun:test";

import {
  SOLARD_MEASURE_SENSITIVE_KEY_PATTERN,
  readMeasureIntEnv,
  solardMeasureRuntimeOptions,
} from "./measure-policy.ts";

function env(values: Record<string, string | undefined>) {
  return (name: string) => values[name];
}

describe("measure policy", () => {
  test("uses bounded numeric environment values", () => {
    expect(readMeasureIntEnv(env({ VALUE: "12.9" }), "VALUE", 4, 20)).toBe(12);
    expect(readMeasureIntEnv(env({ VALUE: "99" }), "VALUE", 4, 20)).toBe(20);
    expect(readMeasureIntEnv(env({ VALUE: "-1" }), "VALUE", 4, 20)).toBe(4);
    expect(readMeasureIntEnv(env({ VALUE: "nope" }), "VALUE", 4, 20)).toBe(4);
  });

  test("builds one deterministic runtime policy", () => {
    const options = solardMeasureRuntimeOptions(
      env({
        SOLARD_MEASURE_TIMESTAMPS: "0",
        SOLARD_MEASURE_SILENT: "1",
        SOLARD_MEASURE_MAX_RESULT_LENGTH: "123",
        SOLARD_MEASURE_MAX_SUMMARY_DEPTH: "8",
        SOLARD_MEASURE_MAX_SUMMARY_STRING_LENGTH: "321",
        SOLARD_MEASURE_ARRAY_SAMPLE: "5",
        SOLARD_MEASURE_OBJECT_KEYS: "40",
      }),
    );

    expect(options).toMatchObject({
      timestamps: false,
      silent: true,
      maxResultLength: 123,
      summarize: true,
      stripScopePrefix: true,
      maxSummaryDepth: 8,
      maxSummaryStringLength: 321,
      summaryArraySample: 5,
      summaryObjectKeys: 40,
    });
  });

  test("redaction policy covers credential-shaped keys", () => {
    for (const key of [
      "privateKey",
      "authorization",
      "api_key",
      "rpc_url",
      "sender_url",
      "cookie",
    ]) {
      expect(SOLARD_MEASURE_SENSITIVE_KEY_PATTERN.test(key)).toBe(true);
    }
  });
});
