import { listWorkerErrors, terminalStoreStats } from "../../../shared/db.js";
import { assertWebAuth } from "../../../src/web/http.js";
import { getSolardRuntimeHealth } from "../../_server/process-health.ts";

function errorLimit(url: URL): number {
  const parsed = Number(url.searchParams.get("errors") ?? 40);

  return Math.max(
    0,
    Math.min(Number.isFinite(parsed) ? Math.trunc(parsed) : 40, 200),
  );
}

export async function GET(request: Request): Promise<Response> {
  try {
    assertWebAuth(request);

    const url = new URL(request.url);

    const limit = errorLimit(url);

    const health = await getSolardRuntimeHealth();

    return Response.json({
      ok: health.ok,

      checkedAtMs: health.checkedAtMs,

      health,

      errors:
        limit > 0
          ? listWorkerErrors({
              limit,
            })
          : [],

      store: terminalStoreStats(),
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
