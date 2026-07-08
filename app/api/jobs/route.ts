import { withMeasuredApi } from "../../../src/web/http.js";
import {
  getJobAction,
  listJobLogsAction,
  listJobsAction,
} from "../../../src/solard/actions/index.js";

export function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  const logs = url.searchParams.get("logs") === "1";
  return withMeasuredApi(
    request,
    id ? (logs ? "jobLogs" : "getJob") : "listJobs",
    async () => {
      if (id && logs) {
        return await listJobLogsAction({
          id,
          limit: Number(url.searchParams.get("limit") ?? "500"),
        });
      }
      if (id) return await getJobAction({ id });
      return await listJobsAction({
        status: url.searchParams.get("status"),
        limit: Number(url.searchParams.get("limit") ?? "100"),
        includeLogs: url.searchParams.get("includeLogs") === "1",
      });
    },
    { meta: { id, logs } },
  );
}
