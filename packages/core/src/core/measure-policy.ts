export type SolardMeasureEnvironment = (name: string) => string | undefined;

export const SOLARD_MEASURE_SENSITIVE_KEY_PATTERN =
  /secret|private|mnemonic|seed|keypair|password|authorization|cookie|token|apikey|api_key|rpc_endpoint|rpc_url|sender_url|endpoint|url/i;

export type SolardMeasureRuntimeOptions = {
  timestamps: boolean;
  silent: boolean;
  maxResultLength: number;
  summarize: boolean;
  stripScopePrefix: boolean;
  maxSummaryDepth: number;
  maxSummaryStringLength: number;
  summaryArraySample: number;
  summaryObjectKeys: number;
  sensitiveKeyPattern: RegExp;
};

export function readMeasureIntEnv(
  env: SolardMeasureEnvironment,
  name: string,
  fallback: number,
  max = 10_000,
): number {
  const raw = env(name);
  if (!raw) return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return fallback;

  return Math.min(Math.floor(value), max);
}

export function solardMeasureRuntimeOptions(
  env: SolardMeasureEnvironment = (name) => process.env[name],
): SolardMeasureRuntimeOptions {
  return {
    timestamps: env("SOLARD_MEASURE_TIMESTAMPS") !== "0",
    silent:
      env("SOLARD_MEASURE") === "0" || env("SOLARD_MEASURE_SILENT") === "1",
    maxResultLength: readMeasureIntEnv(
      env,
      "SOLARD_MEASURE_MAX_RESULT_LENGTH",
      900,
    ),
    summarize: true,
    stripScopePrefix: true,
    maxSummaryDepth: readMeasureIntEnv(
      env,
      "SOLARD_MEASURE_MAX_SUMMARY_DEPTH",
      4,
      20,
    ),
    maxSummaryStringLength: readMeasureIntEnv(
      env,
      "SOLARD_MEASURE_MAX_SUMMARY_STRING_LENGTH",
      160,
      2_000,
    ),
    summaryArraySample: readMeasureIntEnv(
      env,
      "SOLARD_MEASURE_ARRAY_SAMPLE",
      2,
      20,
    ),
    summaryObjectKeys: readMeasureIntEnv(
      env,
      "SOLARD_MEASURE_OBJECT_KEYS",
      24,
      200,
    ),
    sensitiveKeyPattern: SOLARD_MEASURE_SENSITIVE_KEY_PATTERN,
  };
}
