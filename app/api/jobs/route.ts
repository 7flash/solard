import {
  assertWebAuth,
  errorResponse,
  jsonResponse,
} from "../../../src/web/http.js";
import {
  getLaunchJob,
  listLaunchJobs,
  type LaunchJobStatus,
} from "../../../src/web/launch-jobs.js";

function statusParam(value: string | null): LaunchJobStatus | null {
  if (
    value === "queued" ||
    value === "running" ||
    value === "succeeded" ||
    value === "failed"
  ) {
    return value;
  }
  return null;
}

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
    return jsonResponse({
      ok: true,
      value: listLaunchJobs({
        status: statusParam(url.searchParams.get("status")),
        limit: Number(url.searchParams.get("limit") ?? "100"),
      }),
    });
  } catch (error) {
    return errorResponse(
      error,
      typeof (error as { status?: unknown }).status === "number"
        ? (error as { status: number }).status
        : 500,
    );
  }
}
