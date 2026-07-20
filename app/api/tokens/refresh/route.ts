import { readJson, requireString, withSolard } from "../../../../src/web/http.js";
import {
  createSolardActionContext,
  refreshTokenAction,
} from "../../../../src/solard/actions/index.js";

export async function POST(request: Request): Promise<Response> {
  const body = await readJson(request);
  return withSolard(request, async (slrd) => {
    const ctx = createSolardActionContext({ slrd });
    return await refreshTokenAction(ctx, {
      token: requireString(body, "token"),
    });
  });
}
