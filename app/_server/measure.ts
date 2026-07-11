import { configure, createMeasure } from "measure-fn";

configure({
  timestamps: true,
  maxResultLength: 1200,
});

export const m = createMeasure("solard:api");

export function summarizeError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      cause: error.cause ? String(error.cause) : undefined,
    };
  }
  return { message: String(error) };
}

export function errorStatus(error: unknown): number {
  const maybe = error as { status?: unknown; statusCode?: unknown };
  if (typeof maybe.status === "number") return maybe.status;
  if (typeof maybe.statusCode === "number") return maybe.statusCode;
  return 500;
}

export function errorResponse(error: unknown): Response {
  return Response.json(
    {
      ok: false,
      error: summarizeError(error),
    },
    { status: errorStatus(error) },
  );
}

export function intParam(
  url: URL,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(url.searchParams.get(name) ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

export type TerminalSource = "both" | "helius" | "pumpportal" | undefined;

export function resolveTerminalSource(value: unknown): TerminalSource {
  const text = String(value ?? "").toLowerCase();
  if (text.includes("both")) return "both";
  if (text.includes("helius")) return "helius";
  if (text.includes("pump")) return "pumpportal";
  return undefined;
}
