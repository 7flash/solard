/** Build the browser terminal into web/dist (static files only), or serve it for local testing:
 *   bun web/build.ts          -> web/dist/{index.html, app.js}
 *   bun web/build.ts --serve  -> build, then serve web/dist on http://127.0.0.1:5173 (dev only) */
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const dir = import.meta.dir, out = join(dir, "dist");
mkdirSync(out, { recursive: true });
const result = await Bun.build({ entrypoints: [join(dir, "app.ts"), join(dir, "wallets.ts"), join(dir, "discovery.ts"), join(dir, "coin.ts")], outdir: out, target: "browser", minify: true, sourcemap: "linked",
  define: { "process.env.NODE_ENV": '"production"' } });
if (!result.success) { for (const log of result.logs) console.error(log); process.exit(1); }
for (const page of ["index.html", "wallets.html", "discovery.html", "coin.html"]) copyFileSync(join(dir, page), join(out, page));
console.log(`built ${result.outputs.map(o => `${o.path.split(/[\\/]/).pop()} ${(o.size / 1024).toFixed(0)}KB`).join(", ")}`);

if (process.argv.includes("--serve")) {
  Bun.serve({ hostname: "127.0.0.1", port: 5173, fetch: req => {
    const path = new URL(req.url).pathname;
    return new Response(Bun.file(join(out, path === "/" ? "index.html" : path.slice(1))));
  } });
  console.log("serving http://127.0.0.1:5173");
}
