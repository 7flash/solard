import {
  createMeasure,
  summarizeError,
  summarizeForMeasure,
} from "./measure.js";
import { errorResponse, jsonResponse } from "../web/http.js";

export type SolardApiMeta = {
  route?: string;
  method?: string;
  scope?: string;
  requestId?: string;
  tookMs?: number;
  summary?: unknown;
  warnings?: string[];
};

export type SolardApiOk<T> = {
  ok: true;
  value: T;
  meta?: SolardApiMeta;
};

export type SolardApiError = {
  ok: false;
  error: string;
  meta?: SolardApiMeta;
};

export type SolardApiEnvelope<T> = SolardApiOk<T> | SolardApiError;

export { summarizeForMeasure };

export function solardOk<T>(value: T, meta?: SolardApiMeta): SolardApiOk<T> {
  return { ok: true, value, ...(meta ? { meta } : {}) };
}

export function solardError(
  error: unknown,
  meta?: SolardApiMeta,
): SolardApiError {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    ...(meta ? { meta } : {}),
  };
}

export async function measureSolard<T>(
  scope: string,
  label: string,
  fn: () => Promise<T> | T,
  summarize: (value: T) => unknown = (value) => summarizeForMeasure(value),
  options: {
    onError?: (error: unknown) => Promise<T> | T;
    budget?: number;
  } = {},
): Promise<{
  value: T;
  scope: string;
  label: string;
  tookMs: number;
  summary: unknown;
}> {
  const meter = createMeasure(scope);
  const startedAt = Date.now();
  const action = {
    start: () => label,
    end: (result: T) => ({ result: summarize(result) }),
    ...(typeof options.budget === "number" ? { budget: options.budget } : {}),
    ...(options.onError
      ? {
          catch: async (error: unknown) => {
            return await options.onError!(error);
          },
        }
      : {}),
  };
  const value = await meter.measure(action, fn);
  return {
    value,
    scope,
    label,
    tookMs: Date.now() - startedAt,
    summary: summarize(value),
  };
}

function requestId(): string {
  return `req_${Math.random().toString(36).slice(2, 9)}`;
}

export function withMeasuredApi<T>(args: {
  request: Request;
  route: string;
  method?: string;
  label?: string;
  budget?: number;
  summarize?: (value: T) => unknown;
  fn: () => Promise<T> | T;
}): Promise<Response> {
  const method = args.method ?? args.request.method;
  const id = requestId();
  const scope = `solard:api:${method}:${args.route}`;
  const meter = createMeasure(scope);
  const startedAt = Date.now();

  return meter.measure(
    {
      start: () => `${args.label ?? "handle"} ${id}`,
      end: (res: Response) => ({ status: res.status }),
      catch: (error: unknown) => {
        return errorResponse(
          error,
          typeof (error as { status?: unknown }).status === "number"
            ? (error as { status: number }).status
            : 500,
        );
      },
    },
    async () => {
      const value = await meter.measure(
        {
          start: () => args.label ?? "action",
          end: (result: T) => ({
            result: (args.summarize ?? summarizeForMeasure)(result),
          }),
          ...(typeof args.budget === "number" ? { budget: args.budget } : {}),
        },
        args.fn,
      );
      return jsonResponse({
        ok: true,
        value,
        meta: {
          route: args.route,
          method,
          scope,
          requestId: id,
          tookMs: Date.now() - startedAt,
          summary: (args.summarize ?? summarizeForMeasure)(value),
        },
      });
    },
  );
}

export function measuredApiErrorBody(
  error: unknown,
  meta?: SolardApiMeta,
): SolardApiError {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    meta: {
      ...(meta ?? {}),
      summary: summarizeError(error),
    },
  };
}
