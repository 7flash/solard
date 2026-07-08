import { jsonResponse } from "../../../src/web/http.js";
import {
  loadSolardRuntimeConfig,
  publicSolardConfig,
} from "../../../src/solard/config.js";

export function GET(): Response {
  const config = loadSolardRuntimeConfig();
  const errorCount = config.issues.filter(
    (issue) => issue.level === "error",
  ).length;
  return jsonResponse(
    {
      ok: errorCount === 0,
      value: {
        status: errorCount === 0 ? "ok" : "degraded",
        config: publicSolardConfig(config),
      },
      meta: {
        route: "/api/health",
        method: "GET",
        checkedAtMs: Date.now(),
      },
    },
    { status: errorCount === 0 ? 200 : 503 },
  );
}
