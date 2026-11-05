/** Kris's reaction sprites: 8 frames side by side, by name. */
import { readFileSync } from "node:fs";

const NAMES = new Set(["ape", "profit", "loss", "dip", "hold"]);
export async function GET(req: Request) {
  const name = new URL(req.url).searchParams.get("name") ?? "";
  if (!NAMES.has(name)) return new Response("not found", { status: 404 });
  return new Response(readFileSync(new URL(`../../../kris/art/${name}.webp`, import.meta.url)), { headers: { "content-type": "image/webp", "cache-control": "public, max-age=86400" } });
}
