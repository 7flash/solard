import {
  assertWebAuth,
  errorResponse,
  jsonResponse,
} from "../../../src/web/http.js";
import { healthAction } from "../../../src/solard/actions/index.js";

export function GET(request: Request): Response {
  try {
    assertWebAuth(request);
    return jsonResponse({ ok: true, value: healthAction() });
  } catch (error) {
    return errorResponse(
      error,
      typeof (error as { status?: unknown }).status === "number"
        ? (error as { status: number }).status
        : 500,
    );
  }
}
