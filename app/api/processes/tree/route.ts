import {
  assertWebAuth,
  errorResponse,
  jsonResponse,
  readJson,
} from "../../../../src/web/http.js";
import {
  ensureAndInspectProcessTreeAction,
  inspectProcessTreeAction,
  stopProcessTreeAction,
} from "../../../../src/solard/actions/process-tree.js";

function booleanParam(value: string | null): boolean | undefined {
  if (value === null) return undefined;
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  return undefined;
}

export async function GET(request: Request): Promise<Response> {
  try {
    assertWebAuth(request);
    const url = new URL(request.url);
    const value = await inspectProcessTreeAction({
      parent: url.searchParams.get("parent"),
      source: url.searchParams.get("source"),
      telegram: booleanParam(url.searchParams.get("telegram")),
      text: booleanParam(url.searchParams.get("text")) === true,
    });
    return jsonResponse({ ok: true, value });
  } catch (error) {
    return errorResponse(error, typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 500);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertWebAuth(request);
    const body = await readJson(request);
    const action = String(body.action ?? "inspect");
    const input = {
      parent: typeof body.parent === "string" ? body.parent : null,
      source: typeof body.source === "string" ? body.source : null,
      telegram: typeof body.telegram === "boolean" ? body.telegram : undefined,
    };
    const value = action === "ensure"
      ? await ensureAndInspectProcessTreeAction({
          ...input,
          restart: body.restart === true,
          restartStale: body.restartStale === true,
        })
      : action === "stop-parent"
        ? await stopProcessTreeAction(input.parent)
        : await inspectProcessTreeAction(input);
    return jsonResponse({ ok: true, value });
  } catch (error) {
    return errorResponse(error, typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 500);
  }
}
