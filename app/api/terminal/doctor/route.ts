import { runLiveDoctor } from "../../../../src/solard/diagnostics/live-doctor.js";
import {
  createMeasure,
  summarizeError,
  summarizeForMeasure,
} from "../../../../src/solard/measure.js";

const api = createMeasure("api");

function json(value: unknown, status = 200): Response {
  return new Response(
    JSON.stringify(value, (_key, item) =>
      typeof item === "bigint" ? item.toString() : item,
    ),
    {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

export async function GET(request: Request): Promise<Response> {
  return await api.measure(
    {
      start: () => "terminal doctor GET",
      end: (result) => summarizeForMeasure(result),
      catch: (error) => ({ error: summarizeError(error) }),
    },
    async () => {
      const url = new URL(request.url);
      const result = await runLiveDoctor({
        source: url.searchParams.get("source") ?? "helius",
        seconds: url.searchParams.get("seconds") ?? "8",
        writeProbe: url.searchParams.get("writeProbe") ?? "1",
        sampleTransaction: url.searchParams.get("sampleTransaction") ?? "1",
      });
      return json({ ok: result.ok, value: result }, result.ok ? 200 : 207);
    },
  );
}
