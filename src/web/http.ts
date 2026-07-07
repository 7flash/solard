import { createTraderSowl, type Sowl } from "../index.js";

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

export function errorResponse(error: unknown, status = 500): Response {
  const message = error instanceof Error ? error.message : String(error);
  const stack =
    process.env.SOLWAL_WEB_DEBUG === "1" && error instanceof Error
      ? error.stack
      : undefined;
  return jsonResponse({ ok: false, error: message, stack }, { status });
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
  if (typeof value !== "string" || !value.trim())
    throw new Error(`Missing ${key}`);
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
  if (!Number.isFinite(parsed))
    throw new Error(`Invalid ${key}: ${String(value)}`);
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

export function assertWebAuth(request: Request): void {
  const expected = process.env.SOLWAL_WEB_TOKEN?.trim();
  if (!expected) return;
  const supplied = request.headers.get("x-solwal-web-token") ?? "";
  if (supplied !== expected) {
    throw Object.assign(new Error("Unauthorized"), { status: 401 });
  }
}

export async function withSowl<T>(
  request: Request,
  fn: (sowl: Sowl) => Promise<T> | T,
): Promise<Response> {
  let sowl: Sowl | null = null;
  try {
    assertWebAuth(request);
    sowl = createTraderSowl({
      rpcUrl: process.env.HELIUS_RPC_URL || process.env.RPC_ENDPOINT,
    });
    const value = await fn(sowl);
    return jsonResponse({ ok: true, value });
  } catch (error) {
    return errorResponse(
      error,
      typeof (error as { status?: unknown }).status === "number"
        ? (error as { status: number }).status
        : 500,
    );
  } finally {
    sowl?.close();
  }
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
