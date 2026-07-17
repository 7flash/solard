import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] || process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");
const route = read("app/api/launch/pump/route.ts");
const page = read("app/launch/page.client.tsx");

const checks = [
  ["route forces Jito bundle mode", route.includes('normalized.submitMode = "jito-bundle"')],
  ["route forces live execution", route.includes("normalized.live = true")],
  ["route forces skip simulation", route.includes("normalized.skipSimulation = true")],
  ["route limits ordered buyers to four", route.includes("rows.length < 1 || rows.length > 4")],
  ["route rejects deployer reuse", route.includes("cannot use the deployer wallet")],
  ["route owns transport configuration", route.includes('delete normalized[key]') && route.includes('"jitoBlockEngineUrl"')],
  ["page sends Jito mode", page.includes('form.set("submitMode", "jito-bundle")')],
  ["page sends ordered plan", page.includes('form.set("buyPlanJson", JSON.stringify(plan))')],
  ["page has no Helius sender choices", !page.toLowerCase().includes("helius")],
  ["page has no CLI generator", !page.includes("Generate CLI") && !page.includes("PowerShell")],
  ["page polls job status", page.includes('/api/jobs?id=${encodeURIComponent(id)}')],
  ["page restores active job", page.includes("ACTIVE_JOB_STORAGE_KEY")],
  ["page displays Jito bundle ID", page.includes("jobBundleId") && page.includes("Jito bundle")],
  ["page displays all transaction signatures", page.includes("jobSignatures") && page.includes("traderReceipts")],
];

let failed = 0;
for (const [label, ok] of checks) {
  if (ok) console.log(`PASS ${label}`);
  else {
    console.error(`FAIL ${label}`);
    failed += 1;
  }
}
process.exitCode = failed ? 1 : 0;
