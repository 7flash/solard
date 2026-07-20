import {
  readJson,
  requireString,
  optionalString,
  withSolard,
} from "../../../../src/web/http.js";
import {
  createGroupAction,
  createSolardActionContext,
} from "../../../../src/solard/actions/index.js";

export async function POST(request: Request): Promise<Response> {
  const body = await readJson(request);
  return withSolard(request, (slrd) => {
    const ctx = createSolardActionContext({ slrd, installSenders: false });
    return createGroupAction(ctx, {
      name: requireString(body, "name"),
      description: optionalString(body, "description"),
    });
  });
}
