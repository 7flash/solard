import { readJson, requireString, withSolard } from "../../../src/web/http.js";

export async function POST(request: Request): Promise<Response> {
  const body = await readJson(request);
  return withSolard(request, async (slrd) => {
    return await slrd.samplePrice(requireString(body, "token"));
  });
}
