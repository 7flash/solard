import { readFile } from "node:fs/promises";
import { join } from "node:path";

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

const versions = new Set(manifests.map(({ json }) => json.version));

if (versions.size !== 1) {
  throw new Error(
    `Package versions are not synchronized: ${manifests
      .map(({ json }) => `${json.name}@${json.version}`)
      .join(", ")}`
  );
}

const version = manifests[0].json.version;

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`Invalid release version: ${version}`);
}

const internalNames = new Set(manifests.map(({ json }) => json.name));
const dependencyFields = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies"
];

const problems = [];

for (const { json } of manifests) {
  for (const field of dependencyFields) {
    const deps = json[field];
    if (!deps || typeof deps !== "object") continue;

    for (const [name, range] of Object.entries(deps)) {
      if (internalNames.has(name) && range !== version) {
        problems.push(`${json.name} ${field}.${name}=${range}, expected ${version}`);
      }
    }
  }
}

if (problems.length > 0) {
  throw new Error(`Internal dependency version mismatch:\n${problems.join("\n")}`);
}

process.stdout.write(
  `Release verified: ${manifests
    .map(({ json }) => `${json.name}@${json.version}`)
    .join(", ")}\n`
);
