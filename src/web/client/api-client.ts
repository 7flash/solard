import { state } from "./state";

export function authHeaders(): HeadersInit {
  return state.token ? { "x-solwal-web-token": state.token } : {};
}

export function unwrapApiPayload<T>(payload: any, status: number): T {
  if (payload && typeof payload === "object") {
    if (payload.ok === false)
      throw new Error(payload.error ?? payload.message ?? `HTTP ${status}`);
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
  if (!response.ok)
    throw new Error(
      payload?.error ?? payload?.message ?? `HTTP ${response.status}`,
    );
  return unwrapApiPayload<T>(payload, response.status);
}

export async function rawApi<T>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...authHeaders(),
      ...(options.headers ?? {}),
    },
  });
  return await readJsonResponse<T>(response);
}
