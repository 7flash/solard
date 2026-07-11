import { assertWebAuth } from "../../../../src/web/http.js";
import { terminalHealthAction } from "../../../../src/solard/actions/terminal-health.js";
import {
  apiMeasure as m,
  label,
  requestParams,
} from "../../../../src/solard/measure.js";

type Source = "both" | "helius" | "pumpportal" | undefined;
function resolveSource(value: unknown): Source {
  const text = String(value ?? "").toLowerCase();
  if (text.includes("both")) return "both";
  if (text.includes("helius")) return "helius";
  if (text.includes("pump")) return "pumpportal";
  return undefined;
}
function compactError(error: unknown) {
  if (error instanceof Error)
    return { name: error.name, message: error.message };
  return { message: String(error) };
}
function errorStatus(error: unknown): number {
  const maybe = error as any;
  if (typeof maybe?.status === "number") return maybe.status;
  if (typeof maybe?.statusCode === "number") return maybe.statusCode;
  return 500;
}
export async function GET(request: Request): Promise<Response> {
  try {
    const payload = await m(
      label("terminal_health:get", requestParams(request)),
      async () => {
        m.sync("terminal_health:auth", () => {
          assertWebAuth(request);
          return "ok";
        });
        const url = new URL(request.url);
        return terminalHealthAction({
          errors: Math.max(
            0,
            Math.min(Number(url.searchParams.get("errors") ?? "8"), 100),
          ),
          source: resolveSource(url.searchParams.get("source")),
          allErrors: url.searchParams.get("allErrors") === "1",
        });
      },
    );
    return Response.json(payload);
  } catch (error) {
    m.sync("terminal_health:get_error", () => error);
    return Response.json(
      { ok: false, error: compactError(error) },
      { status: errorStatus(error) },
    );
  }
}
