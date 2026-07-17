import { assertWebAuth } from "../../../../src/web/http.js";
import { subscribeAirdropJob } from "../../../../src/solard/airdrops/events.js";
import { getAirdropJob } from "../../../../src/solard/airdrops/job-store.js";
import type { AirdropJob } from "../../../../src/solard/airdrops/types.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const encoder = new TextEncoder();

function terminal(job: AirdropJob): boolean {
  return ["completed", "partial", "failed", "attention", "cancelled"].includes(
    job.status,
  );
}

function event(name: string, value: unknown): Uint8Array {
  return encoder.encode(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`);
}

export async function GET(request: Request): Promise<Response> {
  assertWebAuth(request);
  const url = new URL(request.url);
  const id = (url.searchParams.get("id") ?? "").trim();
  if (!id) {
    return Response.json(
      { ok: false, error: "id is required." },
      { status: 400 },
    );
  }

  const initial = await getAirdropJob(id);
  if (!initial) {
    return Response.json(
      { ok: false, error: "Airdrop job not found." },
      { status: 404 },
    );
  }

  let cleanup: () => void = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let unsubscribe: () => void = () => {};
      let heartbeat: ReturnType<typeof setInterval> | null = null;

      const close = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        if (heartbeat) clearInterval(heartbeat);
        request.signal.removeEventListener("abort", close);
        try {
          controller.close();
        } catch {
          // Stream may already be closed by the runtime/client.
        }
      };

      const push = (job: AirdropJob) => {
        if (closed) return;
        try {
          controller.enqueue(event("job", job));
        } catch {
          close();
          return;
        }
        if (terminal(job)) close();
      };

      cleanup = close;
      request.signal.addEventListener("abort", close, { once: true });
      unsubscribe = subscribeAirdropJob(id, push);
      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          close();
        }
      }, 15_000);

      push(initial);
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
