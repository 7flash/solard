import {
  createMeasure,
  summarizeError,
  summarizeForMeasure,
} from "./measure.ts";
import { errorResponse, jsonResponse } from "../web/http.ts";

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

type Summarizer<T> = (value: T) => unknown;

type MeasureSolardOptions<T> = {
  summarize?: Summarizer<T>;
  end?: Summarizer<T>;
  result?: Summarizer<T>;
  onError?: (error: unknown) => Promise<T> | T;
  catch?: (error: unknown) => Promise<T> | T;
  budget?: number;
  meta?: Record<string, unknown>;
};

function isFunction(value: unknown): value is (...args: any[]) => unknown {
  return typeof value === "function";
}

function normalizeMeasureArgs<T>(
  summarizeOrOptions?: Summarizer<T> | MeasureSolardOptions<T> | null,
  maybeOptions?: MeasureSolardOptions<T> | null,
): { summarize: Summarizer<T>; options: MeasureSolardOptions<T> } {
  if (isFunction(summarizeOrOptions)) {
    return {
      summarize: summarizeOrOptions,
      options: maybeOptions ?? {},
    };
  }

  const options = {
    ...((summarizeOrOptions && typeof summarizeOrOptions === "object"
      ? summarizeOrOptions
      : {}) as MeasureSolardOptions<T>),
    ...(maybeOptions ?? {}),
  };
  const summarize =
    options.summarize ??
    options.end ??
    options.result ??
    ((value: T) => summarizeForMeasure(value));

  return {
    summarize: isFunction(summarize)
      ? summarize
      : (value: T) => summarizeForMeasure(value),
    options,
  };
}

export async function measureSolard<T>(
  scope: string,
  label: string,
  fn: () => Promise<T> | T,
  summarizeOrOptions?: Summarizer<T> | MeasureSolardOptions<T> | null,
  maybeOptions?: MeasureSolardOptions<T> | null,
): Promise<{
  value: T;
  scope: string;
  label: string;
  tookMs: number;
  summary: unknown;
}> {
  const meter = createMeasure(scope);
  const startedAt = Date.now();
  const { summarize, options } = normalizeMeasureArgs<T>(
    summarizeOrOptions,
    maybeOptions,
  );

  const value = await meter.measure(
    {
      start: () => label,
      end: (result: T) => ({ result: summarize(result) }),
      ...(typeof options.budget === "number" ? { budget: options.budget } : {}),
      ...(options.onError || options.catch
        ? {
            catch: async (error: unknown) => {
              const fallback = options.onError ?? options.catch;
              return await fallback!(error);
            },
          }
        : {}),
    },
    fn,
  );

  return {
    value,
    scope,
    label,
    tookMs: Date.now() - startedAt,
    summary: summarize(value),
  };
}

function requestId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `req_${Math.random().toString(36).slice(2, 9)}`;
  }
}

export function withMeasuredApi<T>(args: {
  request: Request;
  route: string;
  method?: string;
  label?: string;
  budget?: number;
  summarize?: Summarizer<T>;
  fn: () => Promise<T> | T;
}): Promise<Response> {
  const method = args.method ?? args.request.method;
  const id = requestId();
  const scope = `solard:api:${method}:${args.route}`;
  const meter = createMeasure(scope);
  const startedAt = Date.now();
  const summarize = isFunction(args.summarize)
    ? args.summarize
    : (value: T) => summarizeForMeasure(value);

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
          {
            route: args.route,
            method,
            scope,
            requestId: id,
            summary: summarizeError(error),
          },
        );
      },
    },
    async () => {
      const value = await meter.measure(
        {
          start: () => args.label ?? "action",
          end: (result: T) => ({ result: summarize(result) }),
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
          summary: summarize(value),
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
    ...(meta ? { meta } : {}),
  };
}
