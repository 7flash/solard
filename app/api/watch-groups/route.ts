import { readJson, withMeasuredApi } from "../../../src/web/http.js";
import {
  addWatchGroupTokenAction,
  createWatchGroupAction,
  listWatchGroupsAction,
  removeWatchGroupTokenAction,
} from "../../../src/solard/actions/index.js";

export function GET(request: Request): Promise<Response> {
  return withMeasuredApi(request, "listWatchGroups", () =>
    listWatchGroupsAction(),
  );
}

export async function POST(request: Request): Promise<Response> {
  const body = await readJson(request);
  const action = String(body.action ?? "");
  return withMeasuredApi(
    request,
    action || "unknown",
    async () => {
      if (action === "create-group") {
        return await createWatchGroupAction({ name: String(body.name ?? "") });
      }
      if (action === "add-token") {
        const token =
          body.token && typeof body.token === "object" ? body.token : {};
        return await addWatchGroupTokenAction({
          groupId: String(body.groupId ?? "main"),
          token: token as Parameters<
            typeof addWatchGroupTokenAction
          >[0]["token"],
        });
      }
      if (action === "remove-token") {
        return await removeWatchGroupTokenAction({
          groupId: String(body.groupId ?? ""),
          mint: String(body.mint ?? ""),
        });
      }
      throw Object.assign(
        new Error(`Unknown watch-groups action: ${action || "(empty)"}`),
        { status: 400 },
      );
    },
    { meta: { action } },
  );
}
