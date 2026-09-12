import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const bump = process.argv[2] ?? "patch";
const allowed = new Set(["patch", "minor", "major"]);

if (!allowed.has(bump)) {
  throw new Error(`Expected patch, minor, or major; received ${bump}`);
}

const packageDirs = ["core", "sdk", "cli", "solard-cli"];
const packagesDir = join(process.cwd(), "packages");
const manifests = [];

for (const dir of packageDirs) {
  const path = join(packagesDir, dir, "package.json");
  const json = JSON.parse(await readFile(path, "utf8"));

  if (typeof json.name !== "string" || typeof json.version !== "string") {
    throw new Error(`Invalid package manifest: packages/${dir}/package.json`);
  }

  manifests.push({ dir, path, json });
}

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);

  if (!match) {
    throw new Error(`Unsupported semver version: ${version}`);
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3])
  };
}

function compareVersions(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

const parsed = manifests.map(({ json }) => ({
  version: json.version,
  parsed: parseVersion(json.version)
}));

let base = parsed[0];

for (const candidate of parsed.slice(1)) {
  if (compareVersions(candidate.parsed, base.parsed) > 0) {
    base = candidate;
  }
}

let { major, minor, patch } = base.parsed;

if (bump === "major") {
  major += 1;
  minor = 0;
  patch = 0;
} else if (bump === "minor") {
  minor += 1;
  patch = 0;
} else {
  patch += 1;
}

const next = `${major}.${minor}.${patch}`;
const internalNames = new Set(manifests.map(({ json }) => json.name));
const dependencyFields = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies"
];

for (const manifest of manifests) {
  manifest.json.version = next;

  for (const field of dependencyFields) {
    const deps = manifest.json[field];
    if (!deps || typeof deps !== "object") continue;

    for (const name of Object.keys(deps)) {
      if (internalNames.has(name)) {
        deps[name] = next;
      }
    }
  }

  await writeFile(manifest.path, `${JSON.stringify(manifest.json, null, 2)}\n`);
}

process.stdout.write(
  `Bumped release from highest current version ${base.version} to ${next}: ${manifests
    .map(({ json }) => json.name)
    .join(", ")}\n`
);
