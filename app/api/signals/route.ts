import { assertWebAuth, readJson } from "../../../src/web/http.js";
import { withMeasuredApi } from "../../../src/solard/api-response.js";
import { createSolardAppServices } from "../../../src/solard/app-services.js";
import { projectSignalToTerminal } from "../../../src/solard/signals/terminal-projection.js";

export function GET(request: Request): Promise<Response> {
  return withMeasuredApi({
    request,
    route: "/api/signals",
    method: "GET",
    label: "list signals",
    fn: () => {
      assertWebAuth(request);
      const app = createSolardAppServices();
      try {
        return app.signals.list();
      } finally {
        app.close();
      }
    },
  });
}

export async function POST(request: Request): Promise<Response> {
  const body = await readJson(request);
  return withMeasuredApi({
    request,
    route: "/api/signals",
    method: "POST",
    label: String(body.action ?? "ingest"),
    fn: async () => {
      assertWebAuth(request);
      const action = typeof body.action === "string" ? body.action : "ingest";
      const app = createSolardAppServices();
      try {
        if (action === "upsert-source") {
          return app.signals.upsertSource({
            id: typeof body.id === "string" ? body.id : undefined,
            name: typeof body.name === "string" ? body.name : "Telegram source",
            chatRef: typeof body.chatRef === "string" ? body.chatRef : null,
            kind: "telegram",
            isActive: body.isActive !== false,
          });
        }
        if (action === "delete-source") {
          return app.signals.deleteSource(String(body.id ?? ""));
        }
        if (action === "clear") {
          return app.signals.clear();
        }
        if (action === "status") {
          return app.signals.updateStatus({
            id: String(body.id ?? ""),
            status: body.status,
            notes: typeof body.notes === "string" ? body.notes : null,
          });
        }

        const text = typeof body.text === "string" ? body.text : "";
        const sourceId =
          typeof body.sourceId === "string" ? body.sourceId : null;
        const raw =
          body.raw && typeof body.raw === "object"
            ? (body.raw as Record<string, unknown>)
            : null;
        const value = app.signals.ingest({
          sourceId,
          text,
          raw,
        });

        const projection = await projectSignalToTerminal({
          id:
            value &&
            typeof value === "object" &&
            typeof (value as { id?: unknown }).id === "string"
              ? String((value as { id: string }).id)
              : null,
          sourceId,
          sourceName:
            value &&
            typeof value === "object" &&
            typeof (value as { sourceName?: unknown }).sourceName === "string"
              ? String((value as { sourceName: string }).sourceName)
              : "web-signals",
          chatRef:
            value &&
            typeof value === "object" &&
            typeof (value as { chatRef?: unknown }).chatRef === "string"
              ? String((value as { chatRef: string }).chatRef)
              : null,
          text,
          raw,
          receivedAtMs: Date.now(),
        });

        return { value, projection };
      } finally {
        app.close();
      }
    },
  });
}
