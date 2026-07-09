import {
  handlePumpLiveGet,
  handlePumpLivePost,
} from "../../../src/pump/services/pump-live-api.js";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.searchParams.get("stream") === "1") {
    const source =
      url.searchParams.get("source") === "pumpportal" ? "pumpportal" : "helius";
    const resetSession =
      url.searchParams.get("reset") === "1" ||
      url.searchParams.get("resetSession") === "1";
    const headers = new Headers(request.headers);
    headers.set("content-type", "application/json");
    return await handlePumpLivePost(
      new Request(request.url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          action: "start-worker",
          source,
          resetSession,
          compatibility: "stream-disabled-bun-safe",
        }),
      }),
    );
  }
  return await handlePumpLiveGet(request);
}

export const POST = handlePumpLivePost;
