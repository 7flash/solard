import { join } from "node:path";

const root = import.meta.dir;
const publicDir = join(root, "public");
const entrypoint = join(root, "src", "main.ts");
const port = Math.max(1, Number(process.env.PORT ?? "4180"));

const build = await Bun.build({
  entrypoints: [entrypoint],
  target: "browser",
  format: "esm",
  minify: false,
  sourcemap: "inline",
});

if (!build.success || !build.outputs[0]) {
  for (const log of build.logs) console.error(log);
  throw new Error("Could not build price stream browser bundle");
}

const browserJs = await build.outputs[0].text();

function file(path: string, type: string): Response {
  return new Response(Bun.file(path), {
    headers: { "content-type": type },
  });
}

const server = Bun.serve({
  hostname: process.env.HOST ?? "127.0.0.1",
  port,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return file(join(publicDir, "index.html"), "text/html; charset=utf-8");
    }
    if (url.pathname === "/styles.css") {
      return file(join(publicDir, "styles.css"), "text/css; charset=utf-8");
    }
    if (url.pathname === "/app.js") {
      return new Response(browserJs, {
        headers: {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }
    if (url.pathname === "/health") {
      return Response.json({ ok: true, app: "solard-price-stream" });
    }
    return new Response("Not found", { status: 404 });
  },
});

console.log(`Solard price stream: http://${server.hostname}:${server.port}`);
console.log("Requires: bun run examples/price-feed-server.ts");
