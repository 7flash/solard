import {
  readJson,
  requireString,
  optionalString,
  withSolard,
} from "../../../../src/web/http.js";
import {
  addTokenAction,
  createSolardActionContext,
} from "../../../../src/solard/actions/index.js";

export async function POST(request: Request): Promise<Response> {
  const body = await readJson(request);
  return withSolard(request, async (slrd) => {
    const ctx = createSolardActionContext({ slrd });
    return await addTokenAction(ctx, {
      mint: requireString(body, "mint"),
      name: optionalString(body, "name"),
      metadataJson: optionalString(body, "metadataJson"),
    });
  });
}
