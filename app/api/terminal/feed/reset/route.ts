import { assertWebAuth } from "../../../../../src/web/http.js";
import { clearTerminalLiveData } from "../../../../../shared/db.js";
import { apiMeasure as m } from "../../../../../src/solard/measure.js";

function compactError(error: unknown) {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { message: String(error) };
}

function errorResponse(error: unknown): Response {
  const value = error as any;
  const status =
    typeof value?.status === "number"
      ? value.status
      : typeof value?.statusCode === "number"
        ? value.statusCode
        : 500;
  return Response.json({ ok: false, error: compactError(error) }, { status });
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertWebAuth(request);

    return await m("terminal_feed_v9:flush", async () => {
      const body = (await request.json().catch(() => ({}))) as {
        pinned?: unknown;
      };
      const pinned = Array.isArray(body.pinned)
        ? [
            ...new Set(
              body.pinned.map((value) => String(value).trim()).filter(Boolean),
            ),
          ].slice(0, 250)
        : [];

      const result = clearTerminalLiveData({
        source: "both",
        pinned,
      });

      return Response.json({
        ok: true,
        buildId: "terminal-feed-v9-sqlite-zod-orm-flush",
        ...result,
      });
    });
  } catch (error) {
    return errorResponse(error);
  }
}
