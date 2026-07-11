import { storageGet } from "./storage";

function authHeaders(): HeadersInit {
  const token = storageGet("solwal:web-token", "");
  return token ? { "x-solwal-web-token": token } : {};
}

export function unwrapApiPayload<T>(payload: any, status: number): T {
  if (payload && typeof payload === "object") {
    if (payload.ok === false) {
      const raw = payload.error ?? payload.message ?? `HTTP ${status}`;
      const message =
        raw && typeof raw === "object" && "message" in raw
          ? String((raw as { message: unknown }).message)
          : String(raw);
      throw new Error(message);
    }
    if (Object.prototype.hasOwnProperty.call(payload, "value"))
      return payload.value as T;
    if (Object.prototype.hasOwnProperty.call(payload, "data"))
      return payload.data as T;
  }
  return payload as T;
}

export async function readJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  let payload: any = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { ok: false, error: text || `HTTP ${response.status}` };
  }
  if (!response.ok) {
    const raw = payload?.error ?? payload?.message ?? `HTTP ${response.status}`;
    const message =
      raw && typeof raw === "object" && "message" in raw
        ? String((raw as { message: unknown }).message)
        : String(raw);
    throw new Error(message);
  }
  return unwrapApiPayload<T>(payload, response.status);
}

export async function api<T = unknown>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const hasBody = options.body != null;
  const headers: HeadersInit = {
    ...authHeaders(),
    ...(hasBody ? { "content-type": "application/json" } : {}),
    ...(options.headers ?? {}),
  };

  const response = await fetch(url, {
    ...options,
    headers,
  });
  return await readJsonResponse<T>(response);
}
