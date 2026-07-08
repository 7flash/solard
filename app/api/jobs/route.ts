import {
  assertWebAuth,
  errorResponse,
  jsonResponse,
} from "../../../src/web/http.js";
import {
  cleanupLaunchJobs,
  getLaunchJob,
  listLaunchJobs,
  listLaunchJobsPage,
  type LaunchJobStatus,
} from "../../../src/web/launch-jobs.js";

function numberParam(url: URL, name: string): number | undefined {
  const value = url.searchParams.get(name);
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
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

    if (url.searchParams.get("cleanup") === "1") {
      return jsonResponse({
        ok: true,
        value: cleanupLaunchJobs({
          olderThanMs: numberParam(url, "olderThanMs"),
        }),
      });
    }

    const wantsPage =
      url.searchParams.has("limit") ||
      url.searchParams.has("cursor") ||
      url.searchParams.has("status");
    if (wantsPage) {
      const status = url.searchParams.get("status") as
        LaunchJobStatus | "any" | null;
      return jsonResponse({
        ok: true,
        value: listLaunchJobsPage({
          limit: numberParam(url, "limit"),
          cursor: url.searchParams.get("cursor"),
          status,
        }),
      });
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
