import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { reviewMain } from "../src/commands/review.mjs";
import { isApplyExcludedPath } from "../src/commands/apply.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repoRoot, "src", "cli.mjs");
const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
let passed = 0;
let failed = 0;

function tempDir(name) {
  return mkdtempSync(join(tmpdir(), `winflow-${name}-`));
}

function run(command, args, { cwd = repoRoot, env = {} } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return {
    ...result,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function runCli(args, options = {}) {
  return run(process.execPath, [cli, ...args], options);
}

function git(cwd, ...args) {
  const result = run("git", args, { cwd });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed:\n${result.stderr}`);
  return result;
}

function write(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok ${passed} - ${name}`);
  } catch (error) {
    failed++;
    console.error(`not ok - ${name}`);
    console.error(error?.stack ?? error);
  }
}

await test("--version matches package.json", () => {
  const result = runCli(["--version"]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), packageJson.version);
});

await test("help dispatches to command-specific help", () => {
  const result = runCli(["help", "review"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:\s*\n\s*winflow review/);
  assert.match(result.stdout, /--all-in-one/);
  assert.match(result.stdout, /--wait/);
});

await test("apply review uses the normal detached new-window mode", () => {
  const source = readFileSync(join(repoRoot, "src", "commands", "apply.mjs"), "utf8");
  assert.match(source, /const reviewArgs = \["--all-in-one"\]/);
  assert.match(source, /await reviewMain\(reviewArgs, \{ excludePath: isApplyExcludedPath \}\)/);
  assert.doesNotMatch(source, /reviewArgs\.push\("--wait"/);
  assert.doesNotMatch(source, /reviewArgs\.push\("--same-terminal"/);
});

await test("apply review filters the same Markdown/patch paths excluded from commit", async () => {
  const cwd = tempDir("apply-review-filter");
  const out = join(cwd, "review-out");
  git(cwd, "init", "-q");
  git(cwd, "config", "user.email", "winflow@example.invalid");
  git(cwd, "config", "user.name", "Winflow Test");
  write(join(cwd, "src", "app.js"), "export const before = 1;\n");
  write(join(cwd, "README.md"), "before docs\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "initial");

  write(join(cwd, "src", "app.js"), "export const after = 2;\n");
  write(join(cwd, "README.md"), "after docs\n");
  write(join(cwd, "notes.patch"), "patch content\n");

  const previous = process.cwd();
  process.chdir(cwd);
  try {
    await reviewMain(["--all-in-one", "--no-open", "--out", out], { excludePath: isApplyExcludedPath });
  } finally {
    process.chdir(previous);
  }

  const review = readFileSync(join(out, "ALL-FILES.review.txt"), "utf8");
  assert.match(review, /src\/app\.js/);
  assert.doesNotMatch(review, /README\.md/);
  assert.doesNotMatch(review, /notes\.patch/);
});

await test("unknown commands fail instead of becoming empty scans", () => {
  const cwd = tempDir("unknown");
  const result = runCli(["reviwe"], { cwd });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown command or missing path: reviwe/);
});

await test("scan preserves case-distinct files and Git ignore semantics", () => {
  const cwd = tempDir("scan");
  git(cwd, "init", "-q");
  if (process.platform !== "win32") {
    write(join(cwd, "A.js"), "export const upper = true;\n");
    write(join(cwd, "a.js"), "export const lower = true;\n");
  } else {
    write(join(cwd, "a.js"), "export const lower = true;\n");
  }
  write(join(cwd, "sub", ".gitignore"), "*.tmp\n!keep.tmp\n");
  write(join(cwd, "sub", "skip.tmp"), "ignored\n");
  write(join(cwd, "sub", "keep.tmp"), "included\n");
  write(join(cwd, "sub", "code.js"), "export const code = true;\n");

  const out = join(cwd, "scan.md");
  const result = runCli(["scan", ".", "--out", out, "--no-open"], { cwd });
  assert.equal(result.status, 0, result.stderr);

  const scan = readFileSync(out, "utf8");
  if (process.platform !== "win32") assert.match(scan, /### A\.js/);
  assert.match(scan, /### a\.js/);
  assert.match(scan, /### sub\/keep\.tmp/);
  assert.match(scan, /### sub\/code\.js/);
  assert.doesNotMatch(scan, /### sub\/skip\.tmp/);
});


await test("scan defaults to opening in a new window and supports --no-open", () => {
  const source = readFileSync(join(repoRoot, "src", "commands", "scan.mjs"), "utf8");
  assert.match(source, /open:\s*true/);
  assert.match(source, /openMode:\s*"new"/);
  const help = runCli(["scan", "--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--no-open/);
  assert.match(help.stdout, /new terminal window\/tab \(default\)/);
});

await test("review uses the empty tree when HEAD is unborn", () => {
  const cwd = tempDir("review-unborn-head");
  const reviewDir = join(cwd, ".reviews");
  git(cwd, "init", "-q");
  write(join(cwd, "src", "app.ts"), "export const first = true;\n");

  const result = runCli(["review", "--all-in-one", "--no-open", "--out", reviewDir], { cwd });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /bad revision ['"]?HEAD/i);

  const rendered = readFileSync(join(reviewDir, "ALL-FILES.review.txt"), "utf8");
  assert.match(rendered, /empty tree \(unborn HEAD\)/);
  assert.match(rendered, /src\/app\.ts/);
  assert.match(rendered, /export const first = true/);
});

await test("review reports invalid revisions and keeps binary changes", () => {
  const cwd = tempDir("review");
  git(cwd, "init", "-q");
  git(cwd, "config", "user.email", "winflow@example.invalid");
  git(cwd, "config", "user.name", "Winflow Test");
  write(join(cwd, "binary.dat"), Buffer.from([0, 1, 2, 3, 0, 4]));
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "initial");

  const invalid = runCli(["review", "--base", "DOES_NOT_EXIST", "--no-open"], { cwd });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /(unknown revision|bad revision|ambiguous argument)/i);

  write(join(cwd, "binary.dat"), Buffer.from([0, 8, 7, 6, 0, 5]));
  const reviewDir = join(cwd, ".reviews");
  const binary = runCli(["review", "--no-open", "--out", reviewDir], { cwd });
  assert.equal(binary.status, 0, binary.stderr);
  const names = readdirSync(reviewDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath ?? entry.path ?? reviewDir, entry.name));
  assert.ok(names.length > 0, "expected a generated review file");
  const rendered = names.map((name) => readFileSync(name, "utf8")).join("\n");
  assert.match(rendered, /binary/i);
});

await test("combined review wraps long source lines without truncating their tails", () => {
  const cwd = tempDir("review-wrap");
  git(cwd, "init", "-q");
  git(cwd, "config", "user.email", "winflow@example.invalid");
  git(cwd, "config", "user.name", "Winflow Test");

  const oldLine = `assert.equal(value, "${"old-".repeat(30)}OLDTAIL");`;
  const newLine = `assert.equal(value, "${"new-".repeat(30)}NEWTAIL");`;
  write(join(cwd, "long.test.mjs"), `${oldLine}\n`);
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "initial");
  write(join(cwd, "long.test.mjs"), `${newLine}\n`);

  const reviewDir = join(cwd, ".reviews");
  const result = runCli(["review", "--all-in-one", "--column-width", "40", "--no-open", "--out", reviewDir], { cwd });
  assert.equal(result.status, 0, result.stderr);
  const rendered = readFileSync(join(reviewDir, "ALL-FILES.review.txt"), "utf8");
  assert.match(rendered, /OLDTAIL/);
  assert.match(rendered, /NEWTAIL/);
  assert.doesNotMatch(rendered, /…/);
});

await test("combined review moves pathological changed lines into compact full-width overflow blocks", () => {
  const cwd = tempDir("review-overflow");
  git(cwd, "init", "-q");
  git(cwd, "config", "user.email", "winflow@example.invalid");
  git(cwd, "config", "user.name", "Winflow Test");

  const oldLine = `const payload = "${"a".repeat(5000)}OLD-OVERFLOW-TAIL";`;
  const newLine = `const payload = "${"b".repeat(5200)}NEW-OVERFLOW-TAIL";`;
  write(join(cwd, "huge.mjs"), `${oldLine}\n`);
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "initial");
  write(join(cwd, "huge.mjs"), `${newLine}\n`);

  const reviewDir = join(cwd, ".reviews");
  const result = runCli(["review", "--all-in-one", "--column-width", "40", "--no-open", "--out", reviewDir], { cwd });
  assert.equal(result.status, 0, result.stderr);
  const rendered = readFileSync(join(reviewDir, "ALL-FILES.review.txt"), "utf8");
  assert.match(rendered, /\[overflow OLD/);
  assert.match(rendered, /\[overflow NEW/);
  assert.match(rendered, /OLD-OVERFLOW-TAIL/);
  assert.match(rendered, /NEW-OVERFLOW-TAIL/);
  assert.doesNotMatch(rendered, /…/);
  assert.ok(rendered.split(/\r?\n/).length < 50, "one pathological source line should not expand into hundreds of review rows");
});

await test("combined review emits identical pathological context once", () => {
  const cwd = tempDir("review-overflow-context");
  git(cwd, "init", "-q");
  git(cwd, "config", "user.email", "winflow@example.invalid");
  git(cwd, "config", "user.name", "Winflow Test");

  const hugeContext = `const generated = "${"z".repeat(5000)}CONTEXT-OVERFLOW-TAIL";`;
  write(join(cwd, "context.mjs"), `${hugeContext}\nexport const value = 1;\n`);
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "initial");
  write(join(cwd, "context.mjs"), `${hugeContext}\nexport const value = 2;\n`);

  const reviewDir = join(cwd, ".reviews");
  const result = runCli(["review", "--all-in-one", "--column-width", "40", "--no-open", "--out", reviewDir], { cwd });
  assert.equal(result.status, 0, result.stderr);
  const rendered = readFileSync(join(reviewDir, "ALL-FILES.review.txt"), "utf8");
  assert.match(rendered, /\[overflow BOTH/);
  assert.equal(rendered.split("CONTEXT-OVERFLOW-TAIL").length - 1, 1, "identical extreme context should be stored once");
});

await test("unzip collision preflight leaves destination untouched", () => {
  const cwd = tempDir("unzip");
  const stage = join(cwd, "stage");
  const dest = join(cwd, "dest");
  mkdirSync(stage, { recursive: true });
  mkdirSync(dest, { recursive: true });
  write(join(stage, "bundle", "a.txt"), "new a\n");
  write(join(stage, "bundle", "z.txt"), "new z\n");
  write(join(dest, "z.txt"), "existing z\n");

  const archive = join(cwd, "bundle.zip");
  const zip = run("zip", ["-qr", archive, "bundle"], { cwd: stage });
  if (zip.error?.code === "ENOENT") {
    console.log("# zip executable unavailable; unzip preflight integration skipped");
    return;
  }
  assert.equal(zip.status, 0, zip.stderr);

  const result = runCli(["unzip", archive, dest], { cwd });
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(join(dest, "z.txt"), "utf8"), "existing z\n");
  assert.equal(existsSync(join(dest, "a.txt")), false, "preflight must prevent partial copies");
});


await test("unzip recognizes when destination already is the archive wrapper", () => {
  const cwd = tempDir("wrapper-root");
  const stage = join(cwd, "stage");
  const dest = join(cwd, "project");
  const stateDir = join(cwd, "state");
  mkdirSync(stage, { recursive: true });
  mkdirSync(dest, { recursive: true });
  write(join(dest, "project", "stale.txt"), "old nested wrapper\n");
  write(join(stage, "project", "src", "index.ts"), "export const value = 1;\n");

  const archive = join(cwd, "project.zip");
  const zip = run("zip", ["-qr", archive, "project"], { cwd: stage });
  if (zip.error?.code === "ENOENT") {
    console.log("# zip executable unavailable; wrapper-root integration skipped");
    return;
  }
  assert.equal(zip.status, 0, zip.stderr);

  const result = runCli(["unzip", archive, dest], {
    cwd,
    env: { WINFLOW_STATE_DIR: stateDir },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(dest, "src", "index.ts"), "utf8"), "export const value = 1;\n");
  assert.equal(readFileSync(join(dest, "project", "stale.txt"), "utf8"), "old nested wrapper\n");
  assert.equal(existsSync(join(dest, "project", "src", "index.ts")), false, "must not merge into project/project when destination already is project");
  assert.match(result.stdout, /destination already matches wrapper: project/);
});

await test("unzip keeps a single-folder root when it matches an existing repo folder", () => {
  const cwd = tempDir("matching-repo-folder");
  const stage = join(cwd, "stage");
  const dest = join(cwd, "repo");
  const stateDir = join(cwd, "state");
  mkdirSync(stage, { recursive: true });
  mkdirSync(dest, { recursive: true });
  write(join(dest, "src", "existing.ts"), "export const existing = true;\n");
  write(join(stage, "src", "incoming.ts"), "export const incoming = true;\n");

  const archive = join(cwd, "incoming.zip");
  const zip = run("zip", ["-qr", archive, "src"], { cwd: stage });
  if (zip.error?.code === "ENOENT") {
    console.log("# zip executable unavailable; matching-repo-folder integration skipped");
    return;
  }
  assert.equal(zip.status, 0, zip.stderr);

  const result = runCli(["unzip", archive, dest], { cwd, env: { WINFLOW_STATE_DIR: stateDir } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(dest, "src", "incoming.ts"), "utf8"), "export const incoming = true;\n");
  assert.equal(existsSync(join(dest, "incoming.ts")), false, "matching repo folder must be preserved");
  assert.match(result.stdout, /merge into existing folder: src/);
});

await test("unzip strips an unmatched single-folder wrapper even with archive metadata", () => {
  const cwd = tempDir("unmatched-wrapper");
  const stage = join(cwd, "stage");
  const dest = join(cwd, "repo");
  const stateDir = join(cwd, "state");
  mkdirSync(stage, { recursive: true });
  mkdirSync(dest, { recursive: true });

  // The repository already has unrelated top-level folders, but not the generated wrapper name.
  write(join(dest, "existing", "keep.txt"), "keep\n");
  write(join(stage, "download-build-9173", "src", "app.ts"), "export const app = true;\n");
  write(join(stage, ".DS_Store"), "archive metadata\n");

  const archive = join(cwd, "incoming.zip");
  const zip = run("zip", ["-qr", archive, "download-build-9173", ".DS_Store"], { cwd: stage });
  if (zip.error?.code === "ENOENT") {
    console.log("# zip executable unavailable; unmatched-wrapper integration skipped");
    return;
  }
  assert.equal(zip.status, 0, zip.stderr);

  const result = runCli(["unzip", archive, dest], {
    cwd,
    env: { WINFLOW_STATE_DIR: stateDir },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(dest, "src", "app.ts"), "utf8"), "export const app = true;\n");
  assert.equal(existsSync(join(dest, "download-build-9173")), false, "unmatched wrapper must be stripped");
  assert.equal(existsSync(join(dest, ".DS_Store")), false, "archive metadata must not be merged into the repo");
  assert.equal(readFileSync(join(dest, "existing", "keep.txt"), "utf8"), "keep\n");
  assert.match(result.stdout, /strip wrapper folder: download-build-9173/);
});

await test("unzip collapses repeated same-name wrapper directories", () => {
  const cwd = tempDir("repeated-wrapper");
  const stage = join(cwd, "stage");
  const dest = join(cwd, "repo");
  const stateDir = join(cwd, "state");
  const wrapper = "slrd-liquidate-safe-v1";
  mkdirSync(stage, { recursive: true });
  mkdirSync(dest, { recursive: true });

  write(
    join(stage, wrapper, wrapper, "reference", "packages", "core", "src", "chain", "liquidation.ts"),
    "export const liquidation = true;\n",
  );

  const archive = join(cwd, "incoming.zip");
  const zip = run("zip", ["-qr", archive, wrapper], { cwd: stage });
  if (zip.error?.code === "ENOENT") {
    console.log("# zip executable unavailable; repeated-wrapper integration skipped");
    return;
  }
  assert.equal(zip.status, 0, zip.stderr);

  const result = runCli(["unzip", archive, dest, "-o"], { cwd, env: { WINFLOW_STATE_DIR: stateDir } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readFileSync(join(dest, "reference", "packages", "core", "src", "chain", "liquidation.ts"), "utf8"),
    "export const liquidation = true;\n",
  );
  assert.equal(existsSync(join(dest, wrapper)), false, "both same-name wrapper levels must be stripped");
  assert.match(result.stdout, /strip wrapper folder: slrd-liquidate-safe-v1/);
  assert.match(result.stdout, /collapsed 1 nested duplicate wrapper/);
});

await test("unzip strips the only unmatched top-level folder even when sibling files exist", () => {
  const cwd = tempDir("one-folder-with-files");
  const stage = join(cwd, "stage");
  const dest = join(cwd, "repo");
  const stateDir = join(cwd, "state");
  mkdirSync(stage, { recursive: true });
  mkdirSync(dest, { recursive: true });

  write(join(dest, "src", "existing.ts"), "export const existing = true;\n");
  write(join(stage, "generated-download-abc", "src", "incoming.ts"), "export const incoming = true;\n");
  write(join(stage, "manifest.json"), "{\"source\":\"download\"}\n");
  write(join(stage, "._generated-download-abc"), "appledouble junk\n");

  const archive = join(cwd, "incoming.zip");
  const zip = run("zip", ["-qr", archive, "generated-download-abc", "manifest.json", "._generated-download-abc"], { cwd: stage });
  if (zip.error?.code === "ENOENT") {
    console.log("# zip executable unavailable; one-folder-with-files integration skipped");
    return;
  }
  assert.equal(zip.status, 0, zip.stderr);

  const result = runCli(["unzip", archive, dest, "-o"], { cwd, env: { WINFLOW_STATE_DIR: stateDir } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(dest, "src", "incoming.ts"), "utf8"), "export const incoming = true;\n");
  assert.equal(readFileSync(join(dest, "manifest.json"), "utf8"), "{\"source\":\"download\"}\n");
  assert.equal(existsSync(join(dest, "generated-download-abc")), false, "the only unmatched top-level directory must be stripped");
  assert.equal(existsSync(join(dest, "._generated-download-abc")), false, "AppleDouble metadata must not be merged");
  assert.match(result.stdout, /strip unmatched wrapper folder: generated-download-abc/);
});

await test("unzip overwrite protects files changed after the previous extraction", () => {
  const cwd = tempDir("repeat-guard");
  const stage = join(cwd, "stage");
  const dest = join(cwd, "project");
  const stateDir = join(cwd, "state");
  mkdirSync(stage, { recursive: true });
  mkdirSync(dest, { recursive: true });
  write(join(stage, "project", "src", "app.ts"), "export const x={a:1};\n");

  const archive = join(cwd, "project.zip");
  const zip = run("zip", ["-qr", archive, "project"], { cwd: stage });
  if (zip.error?.code === "ENOENT") {
    console.log("# zip executable unavailable; repeat-overwrite integration skipped");
    return;
  }
  assert.equal(zip.status, 0, zip.stderr);

  const env = { WINFLOW_STATE_DIR: stateDir };
  const first = runCli(["unzip", archive, dest, "-o"], { cwd, env });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(readFileSync(join(dest, "src", "app.ts"), "utf8"), "export const x={a:1};\n");

  // Simulate prettier/editor output after extraction.
  write(join(dest, "src", "app.ts"), "export const x = { a: 1 };\n");

  const repeat = runCli(["unzip", archive, dest, "-o"], { cwd, env });
  assert.notEqual(repeat.status, 0, "repeat -o must not destroy local formatting/edits");
  assert.match(repeat.stderr, /changed locally since the previous extraction/i);
  assert.match(repeat.stderr, /src\/app\.ts \(modified locally\)/);
  assert.equal(readFileSync(join(dest, "src", "app.ts"), "utf8"), "export const x = { a: 1 };\n");

  const forced = runCli(["unzip", archive, dest, "--force"], { cwd, env });
  assert.equal(forced.status, 0, forced.stderr);
  assert.equal(readFileSync(join(dest, "src", "app.ts"), "utf8"), "export const x={a:1};\n");

  const noop = runCli(["unzip", archive, dest, "-o"], { cwd, env });
  assert.equal(noop.status, 0, noop.stderr);
  assert.match(noop.stdout, /Already applied/i);
});


await test("unzip -o applies a first/new patch archive over differing repo files", () => {
  const cwd = tempDir("patch-overwrite");
  const stage1 = join(cwd, "stage1");
  const stage2 = join(cwd, "stage2");
  const dest = join(cwd, "project");
  const stateDir = join(cwd, "state");
  mkdirSync(stage1, { recursive: true });
  mkdirSync(stage2, { recursive: true });
  mkdirSync(dest, { recursive: true });
  write(join(dest, "src", "app.ts"), "export const x = { a: 0 };\n");
  write(join(stage1, "src", "app.ts"), "export const x={a:1};\n");
  write(join(stage2, "src", "app.ts"), "export const x={a:2};\n");

  const archive1 = join(cwd, "patch-1.zip");
  const archive2 = join(cwd, "patch-2.zip");
  const zip1 = run("zip", ["-qr", archive1, "src"], { cwd: stage1 });
  if (zip1.error?.code === "ENOENT") {
    console.log("# zip executable unavailable; patch overwrite integration skipped");
    return;
  }
  assert.equal(zip1.status, 0, zip1.stderr);
  const zip2 = run("zip", ["-qr", archive2, "src"], { cwd: stage2 });
  assert.equal(zip2.status, 0, zip2.stderr);

  const env = { WINFLOW_STATE_DIR: stateDir };
  const first = runCli(["unzip", archive1, dest, "-o"], { cwd, env });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(readFileSync(join(dest, "src", "app.ts"), "utf8"), "export const x={a:1};\n");

  // Local formatting after patch 1 must not prevent a genuinely new patch 2 from replacing that file.
  write(join(dest, "src", "app.ts"), "export const x = { a: 1 };\n");
  const second = runCli(["unzip", archive2, dest, "-o"], { cwd, env });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readFileSync(join(dest, "src", "app.ts"), "utf8"), "export const x={a:2};\n");
});

await test("apply runs unzip, formatter, detached review, stage exclusions, and commit", () => {
  if (process.platform === "win32") {
    console.log("# apply fake-tool integration is covered on Unix CI; skipped on Windows test host");
    return;
  }

  const cwd = tempDir("apply");
  const home = join(cwd, "home");
  const downloads = join(home, "Downloads");
  const stage = join(cwd, "stage");
  const tools = join(cwd, "tools");
  const stateDir = join(cwd, "state");
  const toolLog = join(cwd, "tools.log");
  mkdirSync(downloads, { recursive: true });
  mkdirSync(stage, { recursive: true });
  mkdirSync(tools, { recursive: true });

  git(cwd, "init", "-q");
  git(cwd, "config", "user.email", "winflow@example.invalid");
  git(cwd, "config", "user.name", "Winflow Test");
  write(join(cwd, "src", "app.ts"), "export const before = true;\n");
  write(join(cwd, "README.md"), "old docs\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "initial");

  // A pre-staged excluded file must still stay out of the final commit.
  write(join(cwd, "README.md"), "locally staged docs\n");
  git(cwd, "add", "README.md");

  write(join(stage, "src", "app.ts"), "export const after={x:1};\n");
  write(join(stage, "README.md"), "new docs\n");
  write(join(stage, "notes.patch"), "patch note\n");
  const archive = join(downloads, "incoming.zip");
  const zip = run("zip", ["-qr", archive, "src", "README.md", "notes.patch"], { cwd: stage });
  if (zip.error?.code === "ENOENT") {
    console.log("# zip executable unavailable; apply integration skipped");
    return;
  }
  assert.equal(zip.status, 0, zip.stderr);

  const bunx = join(tools, "bunx");
  const hx = join(tools, "hx");
  write(bunx, `#!/bin/sh\necho prettier >> ${JSON.stringify(toolLog)}\nexit 0\n`);
  write(hx, `#!/bin/sh\necho review >> ${JSON.stringify(toolLog)}\nexit 0\n`);
  chmodSync(bunx, 0o755);
  chmodSync(hx, 0o755);

  const env = {
    HOME: home,
    WINFLOW_STATE_DIR: stateDir,
    PATH: `${tools}:${process.env.PATH ?? ""}`,
  };
  const applied = runCli(["apply", "x"], { cwd, env });
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(readFileSync(toolLog, "utf8"), /prettier[\s\S]*review/);
  assert.equal(String(run("git", ["log", "-1", "--format=%s"], { cwd }).stdout).trim(), "x");
  const committed = String(run("git", ["show", "--format=", "--name-only", "HEAD"], { cwd }).stdout);
  assert.match(committed, /src\/app\.ts/);
  assert.doesNotMatch(committed, /README\.md/);
  assert.doesNotMatch(committed, /notes\.patch/);
  const status = String(run("git", ["status", "--short"], { cwd }).stdout);
  assert.match(status, /README\.md/);
  assert.match(status, /notes\.patch/);
});


await test("apply creates the first commit in an empty repository with unborn HEAD", () => {
  if (process.platform === "win32") {
    console.log("# empty-repo apply fake-tool integration is covered on Unix CI; skipped on Windows test host");
    return;
  }

  const cwd = tempDir("apply-unborn-head");
  const home = join(cwd, "home");
  const downloads = join(home, "Downloads");
  const stage = join(cwd, "stage");
  const tools = join(cwd, "tools");
  const stateDir = join(cwd, "state");
  const toolLog = join(cwd, "tools.log");
  mkdirSync(downloads, { recursive: true });
  mkdirSync(stage, { recursive: true });
  mkdirSync(tools, { recursive: true });

  git(cwd, "init", "-q");
  git(cwd, "config", "user.email", "winflow@example.invalid");
  git(cwd, "config", "user.name", "Winflow Test");

  write(join(stage, "src", "app.ts"), "export const first={ready:true};\n");
  write(join(stage, "README.md"), "docs stay outside apply commit\n");
  const archive = join(downloads, "first-patch.zip");
  const zip = run("zip", ["-qr", archive, "src", "README.md"], { cwd: stage });
  if (zip.error?.code === "ENOENT") {
    console.log("# zip executable unavailable; empty-repo apply integration skipped");
    return;
  }
  assert.equal(zip.status, 0, zip.stderr);

  const bunx = join(tools, "bunx");
  const hx = join(tools, "hx");
  write(bunx, `#!/bin/sh\necho prettier >> ${JSON.stringify(toolLog)}\nexit 0\n`);
  write(hx, `#!/bin/sh\necho review >> ${JSON.stringify(toolLog)}\nexit 0\n`);
  chmodSync(bunx, 0o755);
  chmodSync(hx, 0o755);

  const env = {
    HOME: home,
    WINFLOW_STATE_DIR: stateDir,
    PATH: `${tools}:${process.env.PATH ?? ""}`,
  };

  const applied = runCli(["apply", "first commit"], { cwd, env });
  assert.equal(applied.status, 0, applied.stderr);
  assert.doesNotMatch(applied.stderr, /bad revision ['"]?HEAD/i);
  assert.match(readFileSync(toolLog, "utf8"), /prettier[\s\S]*review/);
  assert.equal(String(run("git", ["log", "-1", "--format=%s"], { cwd }).stdout).trim(), "first commit");

  const committed = String(run("git", ["show", "--format=", "--name-only", "HEAD"], { cwd }).stdout);
  assert.match(committed, /src\/app\.ts/);
  assert.doesNotMatch(committed, /README\.md/);
  assert.match(String(run("git", ["status", "--short"], { cwd }).stdout), /README\.md/);
});

await test("apply dry-run resolves a specific archive without changing files or Git history", () => {
  const cwd = tempDir("apply-dry-run");
  git(cwd, "init", "-q");
  git(cwd, "config", "user.email", "winflow@example.invalid");
  git(cwd, "config", "user.name", "Winflow Test");
  write(join(cwd, "app.txt"), "before\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "initial");

  const archiveDir = tempDir("apply-dry-run-archive");
  const archive = join(archiveDir, "specific.zip");
  write(archive, "not extracted during dry-run");
  const beforeHead = String(run("git", ["rev-parse", "HEAD"], { cwd }).stdout).trim();

  const result = runCli(["apply", "--dry-run", "--archive", archive, "planned commit"], { cwd });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Dry run:/i);
  assert.match(result.stdout, /specific\.zip/);
  assert.match(result.stdout, /planned commit/);
  assert.equal(readFileSync(join(cwd, "app.txt"), "utf8"), "before\n");
  assert.equal(String(run("git", ["rev-parse", "HEAD"], { cwd }).stdout).trim(), beforeHead);
  assert.equal(String(run("git", ["status", "--porcelain"], { cwd }).stdout).trim(), "");
});

await test("apply forwards review column width instead of adding it to the commit message", () => {
  const cwd = tempDir("apply-width");
  git(cwd, "init", "-q");
  git(cwd, "config", "user.email", "winflow@example.invalid");
  git(cwd, "config", "user.name", "Winflow Test");
  write(join(cwd, "app.txt"), "before\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "initial");

  const archiveDir = tempDir("apply-width-archive");
  const archive = join(archiveDir, "specific.zip");
  write(archive, "dry-run only");

  const result = runCli(["apply", "x", "--column-width", "180", "--dry-run", "--archive", archive], { cwd });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /columns wrap at 180/);
  assert.match(result.stdout, /Commit:\s+x(?:\r?\n|$)/);
  assert.doesNotMatch(result.stdout, /Commit:\s+x --column-width/);
});

await test("apply refuses to start during an in-progress Git operation", () => {
  const cwd = tempDir("apply-merge-guard");
  git(cwd, "init", "-q");
  git(cwd, "config", "user.email", "winflow@example.invalid");
  git(cwd, "config", "user.name", "Winflow Test");
  write(join(cwd, "app.txt"), "before\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "initial");

  const archiveDir = tempDir("apply-merge-archive");
  const archive = join(archiveDir, "specific.zip");
  write(archive, "not reached");
  write(join(cwd, ".git", "MERGE_HEAD"), "0000000000000000000000000000000000000000\n");

  const result = runCli(["apply", "--dry-run", "--archive", archive, "planned commit"], { cwd });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Git merge is in progress/i);
});

await test("apply skips prettier when the repo has no TypeScript files", () => {
  if (process.platform === "win32") {
    console.log("# apply no-TypeScript integration is covered on Unix CI; skipped on Windows test host");
    return;
  }

  const cwd = tempDir("apply-no-ts");
  const home = join(cwd, "home");
  const downloads = join(home, "Downloads");
  const stage = join(cwd, "stage");
  const tools = join(cwd, "tools");
  mkdirSync(downloads, { recursive: true });
  mkdirSync(stage, { recursive: true });
  mkdirSync(tools, { recursive: true });

  git(cwd, "init", "-q");
  git(cwd, "config", "user.email", "winflow@example.invalid");
  git(cwd, "config", "user.name", "Winflow Test");
  write(join(cwd, "src", "app.mjs"), "export const before = true;\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "initial");
  write(join(stage, "src", "app.mjs"), "export const after = true;\n");
  const archive = join(downloads, "incoming.zip");
  const zip = run("zip", ["-qr", archive, "src"], { cwd: stage });
  if (zip.error?.code === "ENOENT") return;
  assert.equal(zip.status, 0, zip.stderr);

  const hx = join(tools, "hx");
  write(hx, "#!/bin/sh\nexit 0\n");
  chmodSync(hx, 0o755);
  const env = { HOME: home, WINFLOW_STATE_DIR: join(cwd, "state"), PATH: `${tools}:${process.env.PATH ?? ""}` };
  const applied = runCli(["apply", "x"], { cwd, env });
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /no \.ts\/\.tsx files; skipped/i);
  assert.equal(String(run("git", ["log", "-1", "--format=%s"], { cwd }).stdout).trim(), "x");
});

await test("apply stops before review and commit when formatting fails", () => {
  if (process.platform === "win32") {
    console.log("# apply failure integration is covered on Unix CI; skipped on Windows test host");
    return;
  }

  const cwd = tempDir("apply-format-fail");
  const home = join(cwd, "home");
  const downloads = join(home, "Downloads");
  const stage = join(cwd, "stage");
  const tools = join(cwd, "tools");
  const toolLog = join(cwd, "tools.log");
  mkdirSync(downloads, { recursive: true });
  mkdirSync(stage, { recursive: true });
  mkdirSync(tools, { recursive: true });

  git(cwd, "init", "-q");
  git(cwd, "config", "user.email", "winflow@example.invalid");
  git(cwd, "config", "user.name", "Winflow Test");
  write(join(cwd, "src", "app.ts"), "export const before = true;\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "initial");
  write(join(stage, "src", "app.ts"), "export const after={x:1};\n");
  const archive = join(downloads, "incoming.zip");
  const zip = run("zip", ["-qr", archive, "src"], { cwd: stage });
  if (zip.error?.code === "ENOENT") return;
  assert.equal(zip.status, 0, zip.stderr);

  const bunx = join(tools, "bunx");
  const hx = join(tools, "hx");
  write(bunx, `#!/bin/sh\necho prettier-failed >> ${JSON.stringify(toolLog)}\nexit 7\n`);
  write(hx, `#!/bin/sh\necho review-should-not-run >> ${JSON.stringify(toolLog)}\nexit 0\n`);
  chmodSync(bunx, 0o755);
  chmodSync(hx, 0o755);

  const env = { HOME: home, WINFLOW_STATE_DIR: join(cwd, "state"), PATH: `${tools}:${process.env.PATH ?? ""}` };
  const applied = runCli(["apply", "x"], { cwd, env });
  assert.notEqual(applied.status, 0);
  assert.match(applied.stderr, /Prettier failed with exit code 7/i);
  const log = readFileSync(toolLog, "utf8");
  assert.match(log, /prettier-failed/);
  assert.doesNotMatch(log, /review-should-not-run/);
  assert.equal(String(run("git", ["log", "-1", "--format=%s"], { cwd }).stdout).trim(), "initial");
});

await test("squash collapses consecutive short HEAD subjects using the argument message", () => {
  const cwd = tempDir("squash");
  git(cwd, "init", "-q");
  git(cwd, "config", "user.email", "winflow@example.invalid");
  git(cwd, "config", "user.name", "Winflow Test");
  write(join(cwd, "a.txt"), "0\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "base commit");
  write(join(cwd, "a.txt"), "1\n");
  git(cwd, "commit", "-qam", "x");
  write(join(cwd, "a.txt"), "2\n");
  git(cwd, "commit", "-qam", "y");

  // `apply` intentionally leaves excluded docs/patches unstaged. Those must not
  // prevent a later squash, and they must remain outside the rewritten commit.
  write(join(cwd, "README.md"), "local docs that must stay unstaged\n");
  write(join(cwd, "notes.patch"), "local patch that must stay untracked\n");

  const squashed = runCli(["squash", "combined implementation"], { cwd });
  assert.equal(squashed.status, 0, squashed.stderr);
  const subjects = String(run("git", ["log", "--format=%s"], { cwd }).stdout).trim().split(/\r?\n/);
  assert.deepEqual(subjects, ["combined implementation", "base commit"]);
  const committed = String(run("git", ["show", "--format=", "--name-only", "HEAD"], { cwd }).stdout);
  assert.doesNotMatch(committed, /README\.md/);
  assert.doesNotMatch(committed, /notes\.patch/);
  const status = String(run("git", ["status", "--short"], { cwd }).stdout);
  assert.match(status, /README\.md/);
  assert.match(status, /notes\.patch/);
});

await test("squash still refuses unrelated staged changes", () => {
  const cwd = tempDir("squash-staged-guard");
  git(cwd, "init", "-q");
  git(cwd, "config", "user.email", "winflow@example.invalid");
  git(cwd, "config", "user.name", "Winflow Test");
  write(join(cwd, "a.txt"), "0\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "base commit");
  write(join(cwd, "a.txt"), "1\n");
  git(cwd, "commit", "-qam", "x");
  write(join(cwd, "staged.txt"), "must not be folded into squash\n");
  git(cwd, "add", "staged.txt");

  const result = runCli(["squash", "combined implementation"], { cwd });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /index has staged changes/i);
  assert.equal(String(run("git", ["log", "-1", "--format=%s"], { cwd }).stdout).trim(), "x");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
