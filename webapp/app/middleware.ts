/** Access: the bridge token once in ?key= sets an HttpOnly, SameSite=Strict cookie; without it nothing is served. */
import { authorized, bridgeToken } from "./lib/bridge.ts";

export default async function middleware(req: Request) {
  const url = new URL(req.url);
  const key = url.searchParams.get("key");
  if (key) {
    if (key !== bridgeToken()) return new Response("bad key", { status: 401 });
    url.searchParams.delete("key");
    return new Response(null, { status: 302, headers: {
      location: url.pathname + url.search,
      "set-cookie": `slrd_web=${key}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`,
    } });
  }
  // Built client assets carry no data; everything else needs the cookie.
  if (!authorized(req) && !/\.(js|css|map)$/.test(url.pathname))
    return new Response("Open the link printed by `bun webapp/server.ts` once.", { status: 401, headers: { "content-type": "text/plain" } });
}
