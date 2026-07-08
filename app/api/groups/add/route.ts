import {
  readJson,
  requireString,
  numberValue,
  withSowl,
} from "../../../../src/web/http.js";
import {
  addWalletToGroupAction,
  createSolardActionContext,
} from "../../../../src/solard/actions/index.js";

export async function POST(request: Request): Promise<Response> {
  const body = await readJson(request);
  return withSowl(request, (sowl) => {
    const ctx = createSolardActionContext({ sowl, installSenders: false });
    return addWalletToGroupAction(ctx, {
      group: requireString(body, "groupName"),
      wallet: requireString(body, "wallet"),
      weightBps: numberValue(body, "weightBps", 10000),
    });
  });
}
