import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import bgrun from "bgrun";
import { assertWebAuth } from "../../../../src/web/http.js";

const ALLOWED = new Set([
  "solard",
  "solard-server-worker",
  "solard-helius-logs-v1",
]);

type Stream = "stdout" | "stderr";

function numberParam(
  value: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(value);

  return Math.max(
    min,
    Math.min(Number.isFinite(parsed) ? Math.trunc(parsed) : fallback, max),
  );
}

function logPath(name: string, stream: Stream): string | null {
  const processInfo = bgrun.getProcess(name) as
    Record<string, unknown> | undefined;

  const keys =
    stream === "stdout"
      ? ["stdout_path", "stdoutPath", "outPath"]
      : ["stderr_path", "stderrPath", "errPath"];

  for (const key of keys) {
    const value = processInfo?.[key];

    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  const home = String((bgrun as any).bgrHome ?? "").trim();

  if (!home) {
    return null;
  }

  return join(
    home,
    stream === "stdout" ? `${name}-out.txt` : `${name}-err.txt`,
  );
}

function tail(
  path: string,
  lines: number,
): {
  text: string;
  size: number;
  modifiedAtMs: number | null;
} {
  if (!existsSync(path)) {
    return {
      text: "(log file does not exist yet)",
      size: 0,
      modifiedAtMs: null,
    };
  }

  const stat = statSync(path);

  const maxBytes = 2 * 1024 * 1024;

  const length = Math.min(stat.size, maxBytes);

  const start = Math.max(0, stat.size - length);

  const fd = openSync(path, "r");

  try {
    const buffer = Buffer.alloc(length);

    readSync(fd, buffer, 0, length, start);

    const text = buffer.toString("utf8").replace(/\r\n/g, "\n");

    return {
      text: text.split("\n").slice(-lines).join("\n"),

      size: stat.size,

      modifiedAtMs: stat.mtimeMs,
    };
  } finally {
    closeSync(fd);
  }
}

function redact(value: string): string {
  return value
    .replace(/([?&](?:api[-_]?key|token|secret|auth|jwt)=)[^&\s]+/gi, "$1***")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer ***")
    .replace(
      /^(\s*(?:SLRD_MASTER_KEY|HELIUS_API_KEY|PINATA_JWT|SOLWAL_WEB_TOKEN)\s*=\s*).+$/gim,
      "$1***",
    );
}

export async function GET(request: Request): Promise<Response> {
  try {
    assertWebAuth(request);

    const url = new URL(request.url);

    const name = String(
      url.searchParams.get("name") ?? "solard-helius-logs-v1",
    );

    if (!ALLOWED.has(name)) {
      return Response.json(
        {
          ok: false,
          error: "Unknown process",
        },
        {
          status: 400,
        },
      );
    }

    const stream: Stream =
      url.searchParams.get("stream") === "stdout" ? "stdout" : "stderr";

    const lines = numberParam(url.searchParams.get("lines"), 300, 20, 2_000);

    const path = logPath(name, stream);

    if (!path) {
      return Response.json({
        ok: true,
        name,
        stream,
        lines,
        text: "(bgrun log path unavailable)",
        size: 0,
        modifiedAtMs: null,
      });
    }

    const value = tail(path, lines);

    return Response.json({
      ok: true,
      name,
      stream,
      lines,
      text: redact(value.text),
      size: value.size,
      modifiedAtMs: value.modifiedAtMs,
    });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      {
        status: 500,
      },
    );
  }
}
