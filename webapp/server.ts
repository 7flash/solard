/** SOLARD single-page web view (tradjs). One page: positions, discovery, decisions, and the selected coin's wallets,
 * trades and trade map. Data comes from the local bridge server-side; the browser never sees the bridge token.
 * Access: open the link printed below once (sets an HttpOnly cookie); without it every request is refused.
 *   bun webapp/server.ts            (port: SLRD_WEB_PORT, default 5176) */
import { serve } from "tradjs/web";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

process.chdir(import.meta.dir);
const port = Number(process.env.SLRD_WEB_PORT ?? 5176);
const token = readFileSync(resolve(import.meta.dir, "..", ".range-bots", "bridge-token"), "utf8").trim();
await serve({ appDir: "./app", port });
console.log(`SOLARD web: http://127.0.0.1:${port}/?key=${token}`);
await new Promise(() => {});
