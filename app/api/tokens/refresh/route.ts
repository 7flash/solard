import { readJson, requireString, withSowl } from "../../../../src/web/http.js";
import {
  createSolardActionContext,
  refreshTokenAction,
} from "../../../../src/solard/actions/index.js";

export async function POST(request: Request): Promise<Response> {
  const body = await readJson(request);
  return withSowl(request, async (sowl) => {
    const ctx = createSolardActionContext({ sowl });
    return await refreshTokenAction(ctx, {
      token: requireString(body, "token"),
    });
  });
}
