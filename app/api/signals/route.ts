import {
  assertWebAuth,
  errorResponse,
  jsonResponse,
  readJson,
} from "../../../src/web/http.js";
import { createSolardAppServices } from "../../../src/solard/app-services.js";

export function GET(request: Request): Response {
  try {
    assertWebAuth(request);
    const app = createSolardAppServices();
    try {
      return jsonResponse({ ok: true, value: app.signals.list() });
    } finally {
      app.close();
    }
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertWebAuth(request);
    const body = await readJson(request);
    const action = typeof body.action === "string" ? body.action : "ingest";
    const app = createSolardAppServices();
    try {
      if (action === "upsert-source") {
        return jsonResponse({
          ok: true,
          value: app.signals.upsertSource({
            id: typeof body.id === "string" ? body.id : undefined,
            name: typeof body.name === "string" ? body.name : "Telegram source",
            chatRef: typeof body.chatRef === "string" ? body.chatRef : null,
            kind: "telegram",
            isActive: body.isActive !== false,
          }),
        });
      }
      if (action === "delete-source")
        return jsonResponse({
          ok: true,
          value: app.signals.deleteSource(String(body.id ?? "")),
        });
      if (action === "clear")
        return jsonResponse({ ok: true, value: app.signals.clear() });
      if (action === "status")
        return jsonResponse({
          ok: true,
          value: app.signals.updateStatus({
            id: String(body.id ?? ""),
            status: body.status,
            notes: typeof body.notes === "string" ? body.notes : null,
          }),
        });
      return jsonResponse({
        ok: true,
        value: app.signals.ingest({
          sourceId: typeof body.sourceId === "string" ? body.sourceId : null,
          text: typeof body.text === "string" ? body.text : "",
          raw: body.raw && typeof body.raw === "object" ? body.raw : null,
        }),
      });
    } finally {
      app.close();
    }
  } catch (error) {
    return errorResponse(error);
  }
}
