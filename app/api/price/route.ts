import { readJson, requireString, withSowl } from "../../../src/web/http.js";

export async function POST(request: Request): Promise<Response> {
  const body = await readJson(request);
  return withSowl(request, async (sowl) => {
    return await sowl.samplePrice(requireString(body, "token"));
  });
}
