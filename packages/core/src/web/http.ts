import { createTraderSolard, type Solard } from "../index.ts";
import {
  createMeasure,
  summarizeError,
  summarizeForMeasure,
} from "../solard/measure.ts";
export { assertWebAuth } from "./auth.ts";
import { assertWebAuth } from "./auth.ts";

export type JsonRecord = Record<string, unknown>;

export function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export function jsonResponse(
  value: unknown,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(value, jsonReplacer, 2), {
    ...init,
    headers,
  });
}

export function errorResponse(
  error: unknown,
  status = 500,
  meta?: Record<string, unknown>,
): Response {
  const message = error instanceof Error ? error.message : String(error);
  const stack =
    (process.env.SOLWAL_WEB_DEBUG === "1" ||
      process.env.SOLARD_WEB_DEBUG === "1") &&
    error instanceof Error
      ? error.stack
      : undefined;
  return jsonResponse(
    { ok: false, error: message, ...(meta ? { meta } : {}), stack },
    { status },
  );
}

export async function readJson<T extends JsonRecord = JsonRecord>(
  request: Request,
): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    return {} as T;
  }
}

export function requireString(body: JsonRecord, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing ${key}`);
  }
  return value.trim();
}

export function optionalString(
  body: JsonRecord,
  key: string,
): string | undefined {
  const value = body[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function numberValue(
  body: JsonRecord,
  key: string,
  fallback: number,
): number {
  const value = body[key];
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${key}: ${String(value)}`);
  }
  return parsed;
}

export function boolValue(
  body: JsonRecord,
  key: string,
  fallback = false,
): boolean {
  const value = body[key];
  if (value == null || value === "") return fallback;
  return value === true || value === "true" || value === "1" || value === 1;
}

function requestId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

function routeMeta(
  request: Request,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const url = new URL(request.url);
  return { route: url.pathname, method: request.method, ...extra };
}

type Summarizer<T> = (value: T) => unknown;

export type MeasuredApiOptions<T = unknown> = {
  meta?: Record<string, unknown>;
  status?: number;
  budget?: number;
  result?: Summarizer<T>;
  summarize?: Summarizer<T>;
  end?: Summarizer<T>;
};

type MeasuredApiObjectArgs<T> = {
  request: Request;
  route?: string;
  method?: string;
  label?: string;
  budget?: number;
  summarize?: Summarizer<T>;
  result?: Summarizer<T>;
  end?: Summarizer<T>;
  status?: number;
  meta?: Record<string, unknown>;
  fn: () => Promise<T> | T;
};

function isObjectApiArgs<T>(value: unknown): value is MeasuredApiObjectArgs<T> {
  return (
    !!value && typeof value === "object" && "request" in value && "fn" in value
  );
}

function normalizeApiArgs<T>(
  arg1: Request | MeasuredApiObjectArgs<T>,
  label?: string,
  fn?: () => Promise<T> | T,
  options: MeasuredApiOptions<T> = {},
): {
  request: Request;
  route: string;
  method: string;
  label: string;
  status: number;
  budget?: number;
  summarize: Summarizer<T>;
  meta: Record<string, unknown>;
  fn: () => Promise<T> | T;
} {
  if (isObjectApiArgs<T>(arg1)) {
    const request = arg1.request;
    const url = new URL(request.url);
    const route = arg1.route ?? url.pathname;
    const method = arg1.method ?? request.method;
    const summarize =
      arg1.summarize ?? arg1.result ?? arg1.end ?? summarizeForMeasure;
    return {
      request,
      route,
      method,
      label: arg1.label ?? "handle",
      status: arg1.status ?? 200,
      budget: arg1.budget,
      summarize,
      meta: { route, method, ...(arg1.meta ?? {}) },
      fn: arg1.fn,
    };
  }

  if (!fn) throw new Error("withMeasuredApi requires a handler function");
  const request = arg1;
  const url = new URL(request.url);
  const route = url.pathname;
  const method = request.method;
  const summarize =
    options.summarize ?? options.result ?? options.end ?? summarizeForMeasure;
  return {
    request,
    route,
    method,
    label: label ?? "handle",
    status: options.status ?? 200,
    budget: options.budget,
    summarize,
    meta: { route, method, ...(options.meta ?? {}) },
    fn,
  };
}

export async function withMeasuredApi<T>(
  arg1: Request | MeasuredApiObjectArgs<T>,
  label?: string,
  fn?: () => Promise<T> | T,
  options: MeasuredApiOptions<T> = {},
): Promise<Response> {
  const args = normalizeApiArgs<T>(arg1, label, fn, options);
  const id = requestId();
  const scope = `solard:api:${args.method}:${args.route}`;
  const meter = createMeasure(scope);
  const startedAt = Date.now();
  const meta = { ...args.meta, requestId: id, scope };

  return await meter.measure(
    {
      start: () => `${args.label} ${id}`,
      end: (res: Response) => ({ status: res.status, ok: res.ok }),
      catch: (error: unknown) => {
        const status =
          typeof (error as { status?: unknown }).status === "number"
            ? (error as { status: number }).status
            : 500;
        return errorResponse(error, status, {
          ...meta,
          label: args.label,
          summary: summarizeError(error),
        });
      },
    },
    async () => {
      assertWebAuth(args.request);
      const value = await meter.measure(
        {
          start: () => `${args.label}:action`,
          end: (result: T) => ({ result: args.summarize(result) }),
          ...(typeof args.budget === "number" ? { budget: args.budget } : {}),
        },
        args.fn,
      );
      return jsonResponse(
        {
          ok: true,
          value,
          meta: {
            ...meta,
            label: args.label,
            tookMs: Date.now() - startedAt,
            summary: args.summarize(value),
          },
        },
        { status: args.status },
      );
    },
  );
}

export async function withSolard<T>(
  request: Request,
  fn: (slrd: Solard) => Promise<T> | T,
): Promise<Response> {
  let slrd: Solard | null = null;
  const url = new URL(request.url);
  const route = url.pathname;
  return await withMeasuredApi(
    request,
    "withSolard",
    async () => {
      slrd = createTraderSolard({
        rpcUrl: process.env.HELIUS_RPC_URL || process.env.RPC_ENDPOINT,
      });
      return await fn(slrd);
    },
    { meta: routeMeta(request, { route }), result: summarizeForMeasure },
  ).finally(() => {
    slrd?.close();
  });
}

export function compactWallet(row: {
  id?: number;
  name?: string | null;
  address: string;
  isActive?: number;
  createdAtMs?: number;
  updatedAtMs?: number;
}) {
  return {
    id: row.id ?? null,
    name: row.name ?? null,
    address: row.address,
    isActive: row.isActive ?? 1,
    createdAtMs: row.createdAtMs ?? null,
    updatedAtMs: row.updatedAtMs ?? null,
  };
}
