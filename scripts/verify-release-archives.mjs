import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

// Install archives outside the workspace: workspace links can hide missing exports.
const root = process.cwd();
const registryVersion = process.argv.find((arg) => arg.startsWith("--registry="))?.split("=")[1];
const dir = await mkdtemp(join(tmpdir(), "solard-release-archives-"));
const archives = join(dir, "archives");
await mkdir(archives);
function run(command, args, cwd = dir) {
  // Only npm's .cmd launcher requires a Windows shell. Quote every archive path.
  const shell = process.platform === "win32" && command === "npm";
  const quotedArgs = shell ? args.map((arg) => {
    if (/["%\r\n]/.test(arg)) throw new Error("Unsupported shell argument");
    return `"${arg}"`;
  }) : args;
  const result = spawnSync(command, quotedArgs, { cwd, encoding: "utf8", shell });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
const dependencies = {};
for (const name of ["core", "sdk", "cli", "solard-cli"]) {
  const packageArchives = join(archives, name);
  await mkdir(packageArchives);
  const manifest = JSON.parse(await readFile(join(root, "packages", name, "package.json"), "utf8"));
  const source = registryVersion ? `${manifest.name}@${registryVersion}` : resolve(root, "packages", name);
  const output = JSON.parse(run("npm", ["pack", source, "--json", "--pack-destination", packageArchives]));
  if (name === "core" || name === "sdk") dependencies[manifest.name] = `file:${join(packageArchives, output[0].filename).replaceAll("\\", "/")}`;
}
await writeFile(join(dir, "package.json"), JSON.stringify({ private: true, type: "module", dependencies, overrides: dependencies }, null, 2));
run("bun", ["install"]);
await writeFile(join(dir, "smoke.ts"), 'import { createTraderSolard } from "@solard/sdk";\nimport { createLiveTradeHistoryRecorder } from "@solard/core";\nif (typeof createTraderSolard !== "function" || typeof createLiveTradeHistoryRecorder !== "function") throw new Error("Missing public runtime export");\nconsole.log("SDK/core runtime exports verified");\n');
process.stdout.write(run("bun", ["run", "smoke.ts"]));
// Explicit installed test paths exercise the SDK that was actually packed.
for (const test of ["live.test.ts", "client.listen-trades.test.ts"]) {
  const result = spawnSync("bun", ["test", `./node_modules/@solard/sdk/src/${test}`], { cwd: dir, encoding: "utf8" });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.status !== 0) throw new Error(`Installed SDK ${test} failed`);
}
const coreTests = spawnSync("bun", ["test", "./node_modules/@solard/core/src"], { cwd: dir, encoding: "utf8" });
process.stdout.write(coreTests.stdout ?? "");
process.stderr.write(coreTests.stderr ?? "");
if (coreTests.status !== 0) throw new Error("Installed core tests failed");
process.stdout.write(`Archive verification passed; isolated project retained at ${dir}\n`);
