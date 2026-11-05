/** Public read-only view: serves the built page and the last snapshot, held in memory only. It has no bridge access,
 * no wallet and no controls; the one write is the snapshot push, which needs the ingest token. */
import { readFileSync } from "node:fs";

const dir = import.meta.dir, token = readFileSync(`${dir}/.token`, "utf8").trim();
const port = Number(process.env.PORT ?? 3030), MAX_BODY = 3_000_000, MAX_COINS = 80;
const files: Record<string, [string, string]> = { "/": ["index.html", "text/html; charset=utf-8"], "/live.js": ["live.js", "text/javascript; charset=utf-8"], "/style.css": ["style.css", "text/css; charset=utf-8"] };
let overview = "null", kris = "[]", ca = ""; const coins = new Map<string, string>(), ART = new Set(["ape", "profit", "loss", "dip", "hold"]);
const json = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const digest = (a: string) => new Bun.CryptoHasher("sha256").update(a).digest("hex");
const allowed = (a: string) => digest(a) === digest(token);

Bun.serve({ port, hostname: "127.0.0.1", maxRequestBodySize: MAX_BODY, async fetch(req) {
  const url = new URL(req.url), f = files[url.pathname];
  if (req.method === "POST" && url.pathname === "/api/ingest") {
    if (!allowed((req.headers.get("authorization") ?? "").replace(/^Bearer /, ""))) return json(`{"error":"no"}`, 401);
    const body = await req.json().catch(() => null) as { overview?: unknown; coin?: { mint?: string }; kris?: unknown; ca?: string } | null;
    if (body?.overview) overview = JSON.stringify(body.overview);
    if (body?.kris) { kris = JSON.stringify(body.kris); ca = String(body.ca ?? ""); }
    if (body?.coin?.mint) {
      coins.delete(body.coin.mint); coins.set(body.coin.mint, JSON.stringify(body.coin));
      if (coins.size > MAX_COINS) coins.delete(coins.keys().next().value!);
    }
    return json(`{"ok":true}`);
  }
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("no", { status: 405 });
  // solard.xyz/terminal with no agent named is the page about the terminal; ?agent=kris is a live terminal.
  if (url.pathname === "/" && (req.headers.get("x-solard-path") ?? "").startsWith("/terminal") && !url.searchParams.get("agent")) return new Response(readFileSync(`${dir}/landing.html`), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
  if (f) return new Response(readFileSync(`${dir}/${f[0]}`), { headers: { "content-type": f[1], "cache-control": "no-cache" } });
  if (url.pathname === "/api/overview") return json(overview);
  if (url.pathname === "/api/kris") return json(`{"events":${kris},"ca":${JSON.stringify(ca)}}`);
  if (url.pathname === "/api/kris/art") { const n = url.searchParams.get("name") ?? ""; return ART.has(n) ? new Response(readFileSync(`${dir}/art/${n}.webp`), { headers: { "content-type": "image/webp", "cache-control": "public, max-age=86400" } }) : new Response("not found", { status: 404 }); }
  if (url.pathname === "/api/coin") { const c = coins.get(url.searchParams.get("mint") ?? ""); return c ? json(c) : json(`{"error":"not tracked"}`, 404); }
  return new Response("not found", { status: 404 });
} });
console.log(`solard live on ${port}`);
