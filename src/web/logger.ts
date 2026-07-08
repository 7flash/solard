export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogRecord = {
  level: LogLevel;
  scope: string;
  message: string;
  at: string;
  data?: unknown;
};

function enabled(level: LogLevel): boolean {
  const configured = (process.env.SOLARD_LOG_LEVEL ?? "info").toLowerCase();
  const order: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
  };
  return order[level] >= (order[configured as LogLevel] ?? 20);
}

function redact(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(/(api-key=)[^&\s]+/gi, "$1***")
      .replace(/(x-solwal-web-token["':\s]+)[^,"'\s]+/gi, "$1***")
      .replace(/(privateKey["':\s]+)[^,"'\s]+/gi, "$1***");
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(
      value as Record<string, unknown>,
    )) {
      out[key] = /secret|private|token|apiKey|api_key/i.test(key)
        ? "***"
        : redact(item);
    }
    return out;
  }
  return value;
}

export function log(
  level: LogLevel,
  scope: string,
  message: string,
  data?: unknown,
): void {
  if (!enabled(level)) return;
  const record: LogRecord = {
    level,
    scope,
    message,
    at: new Date().toISOString(),
    data: data === undefined ? undefined : redact(data),
  };
  const line = `[solard] ${record.at} ${level.toUpperCase()} ${scope} ${message}`;
  if (level === "error") console.error(line, record.data ?? "");
  else if (level === "warn") console.warn(line, record.data ?? "");
  else console.log(line, record.data ?? "");
}

export function scopedLogger(scope: string) {
  return {
    debug: (message: string, data?: unknown) =>
      log("debug", scope, message, data),
    info: (message: string, data?: unknown) =>
      log("info", scope, message, data),
    warn: (message: string, data?: unknown) =>
      log("warn", scope, message, data),
    error: (message: string, data?: unknown) =>
      log("error", scope, message, data),
  };
}
