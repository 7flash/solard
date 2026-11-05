/** Builds the public page into .range-bots/public-dist (index.html, live.js, style.css), with no server-side framework. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const web = resolve(import.meta.dir, ".."), out = resolve(web, "..", ".range-bots", "public-dist");
mkdirSync(out, { recursive: true });
const entry = resolve(web, "public", ".entry.ts");
writeFileSync(entry, `import mount from "../app/page.client.tsx"; mount();\n`);
const r = await Bun.build({ entrypoints: [entry], target: "browser", minify: true });
if (!r.success) throw new Error("build failed");
writeFileSync(resolve(out, "live.js"), await r.outputs[0]!.text());
writeFileSync(resolve(out, "style.css"), readFileSync(resolve(web, "app/globals.css")));
const body = readFileSync(resolve(web, "app/page.tsx"), "utf8").match(/return \(\s*([\s\S]*?)\s*\);\s*}\s*$/)![1]!
  .replace(/className=/g, "class=").replace(/ autoComplete=/g, " autocomplete=").replace(/<(div|canvas)([^>]*?) \/>/g, "<$1$2></$1>");
writeFileSync(resolve(out, "index.html"), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>SOLARD live</title><link rel="stylesheet" href="style.css"></head><body>${body}<script type="module" src="live.js"></script></body></html>`);
// krisagent.xyz: the room, with the monitor on the public terminal.
const krisOut = resolve(out, "kris"); mkdirSync(krisOut, { recursive: true });
const krisEntry = resolve(web, "public", ".kris-entry.ts");
writeFileSync(krisEntry, `import mount from "../app/kris/page.client.tsx"; mount();\n`);
const k = await Bun.build({ entrypoints: [krisEntry], target: "browser", minify: true });
if (!k.success) throw new Error("kris build failed");
writeFileSync(resolve(krisOut, "kris.js"), await k.outputs[0]!.text());
writeFileSync(resolve(krisOut, "style.css"), readFileSync(resolve(web, "app/globals.css"), "utf8") + readFileSync(resolve(web, "app/kris/page.css"), "utf8"));
const page = readFileSync(resolve(web, "app/kris/page.tsx"), "utf8");
const figure = page.match(/function Figure\(\) \{\s*return ([\s\S]*?);\s*\}/)![1]!, room = page.match(/KrisRoom\(\) \{\s*return \(\s*([\s\S]*?)\s*\);\s*\}\s*$/)![1]!;
const html = room.replace("<Figure />", figure).replace(/className=/g, "class=").replace("./?embed=1&sort=last&dir=desc", "https://solard.xyz/terminal/?agent=kris&embed=1&sort=last&dir=desc")
  .replace(/strokeWidth=/g, "stroke-width=").replace(/strokeLinejoin=/g, "stroke-linejoin=").replace(/<(div|canvas|iframe|span|i)([^>]*?) ?\/>/g, "<$1$2></$1>");
// art: copied to the server as webapp/app/kris/art/*.webp
writeFileSync(resolve(krisOut, "index.html"), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Kris</title><meta name="description" content="Kris, an AI agent trading live through Solard."><link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet"><link rel="stylesheet" href="/style.css"></head><body>${html}<div id="tip" class="tip"></div><script src="/kris.js"></script></body></html>`);
console.log("built", out);
