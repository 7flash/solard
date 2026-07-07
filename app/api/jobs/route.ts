import {
  assertWebAuth,
  errorResponse,
  jsonResponse,
} from "../../../src/web/http.js";
import { getLaunchJob, listLaunchJobs } from "../../../src/web/launch-jobs.js";

export function GET(request: Request): Response {
  try {
    assertWebAuth(request);
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    if (id) {
      const job = getLaunchJob(id);
      if (!job)
        return jsonResponse(
          { ok: false, error: "Unknown job" },
          { status: 404 },
        );
      return jsonResponse({ ok: true, value: job });
    }
    return jsonResponse({ ok: true, value: listLaunchJobs() });
  } catch (error) {
    return errorResponse(
      error,
      typeof (error as { status?: unknown }).status === "number"
        ? (error as { status: number }).status
        : 500,
    );
  }
}
