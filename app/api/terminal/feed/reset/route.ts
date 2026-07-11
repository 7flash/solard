import {
  resetTerminalFeed,
  terminalStoreStats,
} from "../../../../../shared/db.js";
import { assertWebAuth } from "../../../../../src/web/http.js";
import {
  errorResponse,
  m,
  summarizeError,
} from "../../../../_server/measure.js";

type ResetBody = {
  pinned?: unknown;
};

function pinnedMints(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return [
    ...new Set(value.map((item) => String(item).trim()).filter(Boolean)),
  ].slice(0, 250);
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertWebAuth(request);

    const body = (await request.json().catch(() => ({}))) as ResetBody;

    const pinned = pinnedMints(body.pinned);

    const result = await m(
      {
        start: () => `terminal_feed:reset pinned=${pinned.length}`,

        end: (value) => value,

        catch: summarizeError,
      },
      async () => {
        const reset = resetTerminalFeed({
          pinnedMints: pinned,
        });

        return {
          ok: true,

          resetAtMs: reset.state.resetAtMs,

          pinned: reset.pinnedMints,

          store: terminalStoreStats({
            pinnedMints: pinned,
          }),

          mode: "logical-feed-reset",

          historyDeleted: false,
        };
      },
    );

    return Response.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
