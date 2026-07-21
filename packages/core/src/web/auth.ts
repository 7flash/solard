import { timingSafeEqual } from "node:crypto";
import {
  allowOpenWebAuth,
  configuredWebToken,
} from "../solard/safety.ts";

/**
 * Fail-closed web API authentication.
 *
 * - Requires SOLARD_WEB_TOKEN (or legacy SOLWAL_/SLRD_ aliases) by default.
 * - Set SOLARD_ALLOW_OPEN_WEB=1 only for intentional local open access.
 * - Accepts x-solard-web-token, x-solwal-web-token, or Authorization: Bearer.
 */
export function assertWebAuth(request: Request): void {
  const expected = configuredWebToken();
  if (!expected) {
    if (allowOpenWebAuth()) return;
    throw Object.assign(
      new Error(
        "Web auth is not configured. Set SOLARD_WEB_TOKEN (or legacy SOLWAL_WEB_TOKEN) before exposing the API. For intentional local open access only, set SOLARD_ALLOW_OPEN_WEB=1.",
      ),
      { status: 503 },
    );
  }

  const supplied =
    request.headers.get("x-solwal-web-token") ??
    request.headers.get("x-solard-web-token") ??
    bearerToken(request.headers.get("authorization")) ??
    "";

  if (!safeTokenEqual(supplied, expected)) {
    throw Object.assign(new Error("Unauthorized"), { status: 401 });
  }
}

function bearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = /^\s*Bearer\s+(.+?)\s*$/i.exec(header);
  return match?.[1] ?? null;
}

function safeTokenEqual(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
