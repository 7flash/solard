import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
function file(path) { return readFileSync(join(root, path), "utf8"); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const store = file("src/solard/db/terminal-store.ts");
const curve = file("src/solard/helius/curve-snapshot.ts");
const worker = file("src/solard/workers/curve-snapshot-worker.ts");
const bgrun = file("src/solard/processes/bgrun.ts");
const meta = file("src/solard/helius/token-metadata.ts");
const feed = file("app/api/terminal/feed/route.ts");

assert(store.includes("listTerminalCurveSnapshotCandidates"), "store missing candidate query");
assert(store.includes("applyTerminalCurveSnapshot"), "store missing snapshot apply");
assert(curve.includes("getMultipleAccounts"), "curve snapshot must use getMultipleAccounts");
assert(curve.includes("decodeBondingCurveAccount"), "curve snapshot must decode bonding curve account");
assert(curve.includes("virtualSolReserves"), "curve snapshot must use virtual reserves");
assert(worker.includes("curve-snapshots-v1-bonding-account"), "worker build id missing");
assert(bgrun.includes('"solard-curve-snapshots"'), "bgrun worker not registered");
assert(bgrun.includes("curve-snapshot-worker.ts"), "bgrun command missing");
assert(meta.includes("fetchMetaplexTokenMetadata"), "metaplex fallback missing");
assert(meta.includes("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"), "token metadata program missing");
assert(feed.includes("refreshTerminalCurveSnapshots"), "feed must trigger curve refresh");
console.log("PASS curve snapshot smoke");
