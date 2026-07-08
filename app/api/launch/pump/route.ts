import {
  assertWebAuth,
  errorResponse,
  jsonResponse,
  readJson,
} from "../../../../src/web/http.js";
import { pumpLaunchInputFromRecord } from "../../../../src/solard/actions/index.js";
import { startPumpLaunchJob } from "../../../../src/web/launch-jobs.js";

export async function POST(request: Request): Promise<Response> {
  try {
    assertWebAuth(request);
    const body = await readJson(request);
    const input = pumpLaunchInputFromRecord(body);
    const job = startPumpLaunchJob(input);
    return jsonResponse({
      ok: true,
      value: {
        id: job.id,
        status: job.status,
        input: job.input,
        argv: job.argv,
      },
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
