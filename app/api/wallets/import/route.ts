import {
  compactWallet,
  readJson,
  requireString,
  optionalString,
  withSowl,
} from "../../../../src/web/http.js";

export async function POST(request: Request): Promise<Response> {
  const body = await readJson(request);
  return withSowl(request, (sowl) => {
    const wallet = sowl.importWallet(
      requireString(body, "privateKey"),
      optionalString(body, "name"),
    );
    return compactWallet(wallet);
  });
}
