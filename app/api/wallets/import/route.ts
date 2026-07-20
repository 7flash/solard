import {
  readJson,
  requireString,
  optionalString,
  withSolard,
} from "../../../../src/web/http.js";
import {
  createSolardActionContext,
  importWalletAction,
} from "../../../../src/solard/actions/index.js";

export async function POST(request: Request): Promise<Response> {
  const body = await readJson(request);
  return withSolard(request, (slrd) => {
    const ctx = createSolardActionContext({ slrd, installSenders: false });
    return importWalletAction(ctx, {
      privateKey: requireString(body, "privateKey"),
      name: optionalString(body, "name"),
    });
  });
}
