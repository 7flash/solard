import {
  readJson,
  requireString,
  numberValue,
  withSolard,
} from "../../../../src/web/http.js";
import {
  addWalletToGroupAction,
  createSolardActionContext,
} from "../../../../src/solard/actions/index.js";

export async function POST(request: Request): Promise<Response> {
  const body = await readJson(request);
  return withSolard(request, (slrd) => {
    const ctx = createSolardActionContext({ slrd, installSenders: false });
    return addWalletToGroupAction(ctx, {
      group: requireString(body, "groupName"),
      wallet: requireString(body, "wallet"),
      weightBps: numberValue(body, "weightBps", 10000),
    });
  });
}
