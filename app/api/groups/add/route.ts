import {
  readJson,
  requireString,
  numberValue,
  withSowl,
} from "../../../../src/web/http.js";

export async function POST(request: Request): Promise<Response> {
  const body = await readJson(request);
  return withSowl(request, (sowl) => {
    const groupName = requireString(body, "groupName");
    sowl.groups.create(groupName);
    const wallet = sowl.resolveWallet(requireString(body, "wallet"));
    return sowl.groups.addWallet(
      groupName,
      wallet.address.toBase58(),
      numberValue(body, "weightBps", 10000),
    );
  });
}
