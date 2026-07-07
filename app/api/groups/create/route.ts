import {
  readJson,
  requireString,
  optionalString,
  withSowl,
} from "../../../../src/web/http.js";

export async function POST(request: Request): Promise<Response> {
  const body = await readJson(request);
  return withSowl(request, (sowl) => {
    return sowl.groups.create(
      requireString(body, "name"),
      optionalString(body, "description"),
    );
  });
}
