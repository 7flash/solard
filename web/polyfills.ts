/** Node globals the SDK code expects, for the browser. Imported first by app.ts. */
import { Buffer } from "buffer";
const g = globalThis as Record<string, unknown>;
g.Buffer ??= Buffer;
g.process ??= { env: {}, argv: [], platform: "browser", nextTick: (fn: () => void) => queueMicrotask(fn) };
g.global ??= globalThis;
