import { mkdirSync, mkdtempSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve, join, relative } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const builds = resolve(root, ".declaration-build");
mkdirSync(builds, { recursive: true });
const staging = mkdtempSync(join(builds, "run-"));
const config = join(staging, "tsconfig.json");
writeFileSync(config, JSON.stringify({
  extends: resolve(root, "tsconfig.json"),
  compilerOptions: { noEmit: false, declaration: true, emitDeclarationOnly: true,
    noCheck: true, declarationMap: false, rootDir: resolve(root, "packages"), outDir: "./output" },
  files: ["core/src/index.ts", "sdk/src/index.ts", "sdk/src/protocol.ts", "sdk/src/browser/index.ts"]
    .map(entry => resolve(root, "packages", entry)), include: [],
}));
const compiler = resolve(root, "node_modules/typescript/bin/tsc");
const result = spawnSync(process.execPath, [compiler, "-p", config], { cwd: root, encoding: "utf8" });
if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
function relativePath(from, to) {
  const value = relative(from, to).replaceAll("\\", "/");
  return value.startsWith(".") ? value : `./${value}`;
}
function copy(directory) {
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, item.name);
    if (item.isDirectory()) { copy(file); continue; }
    const relative = file.slice(join(staging, "output").length + 1).replaceAll("\\", "/");
    const match = /^(core|sdk)\/src\/(.*)$/.exec(relative);
    if (!match) throw new Error(`Unexpected declaration output: ${relative}`);
    const output = resolve(root, "packages", match[1], "dist/types", match[2]);
    mkdirSync(dirname(output), { recursive: true });
    let text = readFileSync(file, "utf8");
    if (text.includes('"sqlite-zod-orm"')) {
      const target = resolve(root, "packages/core/dist/types/vendor/sqlite-zod-orm/index.js");
      const specifier = relativePath(dirname(output), target);
      text = text.replaceAll('"sqlite-zod-orm"', JSON.stringify(specifier));
    }
    writeFileSync(output, text.replace(/(["'])(\.{1,2}\/[^"']+)\.ts\1/g, "$1$2.js$1"));
  }
}
copy(join(staging, "output"));
// sqlite-zod-orm publishes source as its types. Emit its own declarations so
// importing Solard does not typecheck its old, incompatible measure-fn source.
const vendorOutput = join(staging, "vendor");
function sources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(item => {
    const file = join(directory, item.name);
    return item.isDirectory() ? sources(file)
      : item.name.endsWith(".ts") && !item.name.endsWith(".test.ts") ? [file] : [];
  });
}
writeFileSync(config, JSON.stringify({ compilerOptions: {
  target: "ES2022", module: "ESNext", moduleResolution: "Bundler",
  declaration: true, emitDeclarationOnly: true, noCheck: true, skipLibCheck: true,
  rootDir: resolve(root, "node_modules/sqlite-zod-orm/src"), outDir: vendorOutput,
}, files: sources(resolve(root, "node_modules/sqlite-zod-orm/src")) }));
const vendorResult = spawnSync(process.execPath, [compiler, "-p", config], { cwd: root, encoding: "utf8" });
if (vendorResult.status !== 0) throw new Error(`${vendorResult.stdout}\n${vendorResult.stderr}`);
function copyVendor(directory) {
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, item.name);
    if (item.isDirectory()) { copyVendor(file); continue; }
    const destination = resolve(root, "packages/core/dist/types/vendor/sqlite-zod-orm", relative(vendorOutput, file));
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, readFileSync(file, "utf8"));
  }
}
copyVendor(vendorOutput);
const ormManifest = JSON.parse(readFileSync(resolve(root, "node_modules/sqlite-zod-orm/package.json"), "utf8"));
writeFileSync(resolve(root, "packages/core/dist/types/vendor/sqlite-zod-orm/NOTICE.md"),
  `Declarations generated from sqlite-zod-orm ${ormManifest.version}.\n` +
  `Author: ${ormManifest.author}. License: ${ormManifest.license}.\n` +
  `Source: https://github.com/7flash/sqlite-zod-orm\n`);
console.error("Core and curated SDK declarations generated");

