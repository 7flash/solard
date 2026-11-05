/** A real browser window on pump.fun, shown on Kris's monitor. It only looks: it holds no wallet, never signs in and
 * never clicks. Trades still go through the terminal. The Cloudflare check is left for a person to click. */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const dot = resolve(import.meta.dir, ".range-bots"), token = readFileSync(resolve(dot, "public-token"), "utf8").trim();
const bridgeToken = readFileSync(resolve(dot, "bridge-token"), "utf8").trim();
const target = process.env.SLRD_SCREEN_URL ?? "https://solard.xyz/live/api/screen", view = "http://127.0.0.1:5176";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", PORT = 9361, HOME = "https://pump.fun/";
/** SLRD_SCREEN_DRY=1 writes frames to .range-bots/screen.jpg and sends nothing, to check them first. */
const dry = process.env.SLRD_SCREEN_DRY === "1";
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

/** Only pump.fun, and only a coin page or the front page. */
export const coinPage = (mint: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint) ? `https://pump.fun/coin/${mint}` : HOME;
export const onPump = (url: string) => { try { return new URL(url).hostname === "pump.fun"; } catch { return false; } };
export const blocked = (title: string) => /just a moment|security verification|attention required/i.test(title);

// A private window with no extensions and no sync, so nothing of the owner's can load into it.
Bun.spawn([EDGE, `--remote-debugging-port=${PORT}`, `--user-data-dir=${resolve(dot, "browser-clean")}`, "--inprivate", "--disable-extensions", "--disable-sync", "--no-first-run", "--no-default-browser-check", "--window-size=1320,860", "about:blank"], { stdout: "ignore", stderr: "ignore" });
let page: { webSocketDebuggerUrl: string } | null = null;
for (let i = 0; i < 60 && !page; i++) {
  await sleep(500);
  // Our own tab, never one that was already open.
  page = await fetch(`http://127.0.0.1:${PORT}/json/new?${HOME}`, { method: "PUT" }).then(r => r.ok ? r.json() as Promise<{ webSocketDebuggerUrl: string }> : null).catch(() => null);
}
if (!page) throw new Error("browser did not open");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => { ws.onopen = r; });
let id = 0;
const waits = new Map<number, (v: any) => void>();
ws.onmessage = e => { const m = JSON.parse(String(e.data)); waits.get(m.id)?.(m.result); waits.delete(m.id); };
const cdp = (method: string, params: Record<string, unknown> = {}) => new Promise<any>(r => { waits.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
await cdp("Page.enable");
log("browser open on pump.fun");

let here = HOME, wasBlocked = false;
async function latestCoin() {
  const ov: any = await fetch(`${view}/api/overview`, { headers: { cookie: `slrd_web=${bridgeToken}` }, signal: AbortSignal.timeout(10_000) }).then(r => r.json()).catch(() => null);
  const pump = (ov?.bots ?? []).filter((b: any) => !b.inactive && b.lastTradeAtMs).sort((a: any, b: any) => b.lastTradeAtMs - a.lastTradeAtMs)[0];
  return pump?.mint ?? "";
}
setInterval(async () => {
  if (wasBlocked) return;
  const next = coinPage(await latestCoin());
  if (next !== here) { here = next; await cdp("Page.navigate", { url: next }); log(`looking at ${next}`); }
}, 30_000);

for (;;) {
  const seen = (await cdp("Runtime.evaluate", { expression: "JSON.stringify([document.title, location.href])", returnByValue: true }))?.result?.value ?? '["",""]';
  const [title, href] = JSON.parse(seen) as [string, string];
  const stop = blocked(title) || !onPump(href);
  if (stop !== wasBlocked) { wasBlocked = stop; log(stop ? "Cloudflare check showing: click it in the browser window" : "check passed, streaming"); }
  if (!stop) {
    const shot = await cdp("Page.captureScreenshot", { format: "jpeg", quality: 55 });
    if (shot?.data && dry) writeFileSync(resolve(dot, "screen.jpg"), Buffer.from(shot.data, "base64"));
    else if (shot?.data) {
      const r = await fetch(target, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "image/jpeg", "x-screen-url": here }, body: Buffer.from(shot.data, "base64"), signal: AbortSignal.timeout(8_000) }).catch(e => { log(`push: ${String(e).slice(0, 80)}`); return null; });
      if (r && !r.ok) log(`push: ${r.status}`);
    }
  }
  await sleep(1_500);
}
