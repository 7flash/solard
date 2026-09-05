import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { commandExists, isWindows } from "../lib/terminal.mjs";
import { directoryExists, mergeDirectoryContents, visibleEntries } from "../lib/fsx.mjs";
import {
  archiveFingerprint,
  findChangedSinceSnapshot,
  readUnzipState,
  snapshotFiles,
  writeUnzipState,
} from "../lib/unzip-state.mjs";

function usage() {
  console.log(`Usage:
  winflow unzip
  winflow unzip <archive.zip>
  winflow unzip <archive.zip> [destination]
  winflow unzip -d <destination> <archive.zip>
  winflow unzip <archive.zip> -o
  winflow unzip <archive.zip> --force
  winflow unzip <archive.zip> --keep-root

Default:
  Without an archive argument, extracts the latest .zip from ~/Downloads into the current directory.

Smart root-folder behavior:
  If the zip contains exactly one meaningful top-level folder, Winflow treats it as a wrapper candidate.
  If that name matches the destination itself, or an existing top-level folder in the destination, it merges
  into that matching folder. If the name matches neither, the wrapper is stripped before merging. Common
  archive metadata such as __MACOSX and .DS_Store does not count as a second top-level entry.

Safe repeat behavior:
  --overwrite means a new patch ZIP is authoritative and may replace existing destination files. Winflow
  remembers the last successful archive outside the project directory only to detect accidental reapplication
  of that exact same ZIP after local edits. Use --force only when you intentionally want to reapply it anyway.

Options:
  -d, --dest <dir>    Destination folder. Default: current directory.
  -o, --overwrite     Replace existing files with the incoming ZIP. Same-archive reapply remains guarded.
  --force             Reapply even the same ZIP over locally changed files. Implies --overwrite.
  --keep-root         Preserve the archive's top-level folder instead of stripping it.
  -h, --help          Show help.
`);
}

function homeDir() {
  return process.env.HOME || process.env.USERPROFILE || ".";
}

function latestZipInDir(dir) {
  if (!existsSync(dir)) return "";

  const zips = readdirSync(dir)
    .filter((name) => extname(name).toLowerCase() === ".zip")
    .map((name) => {
      const fullPath = join(dir, name);
      try {
        const st = statSync(fullPath);
        return { fullPath, mtime: st.mtimeMs, isFile: st.isFile() };
      } catch {
        return null;
      }
    })
    .filter((x) => x && x.isFile)
    .sort((a, b) => b.mtime - a.mtime);

  return zips[0]?.fullPath ?? "";
}

export function defaultZip() {
  const downloads = join(homeDir(), "Downloads");
  const zip = latestZipInDir(downloads);

  if (!zip) throw new Error(`No .zip files found in: ${downloads}`);
  return zip;
}

function parseArgs(argv) {
  const opts = {
    archive: "",
    dest: "",
    overwrite: false,
    force: false,
    keepRoot: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "-h" || arg === "--help") {
      opts.help = true;
      continue;
    }

    if (arg === "-o" || arg === "--overwrite") {
      opts.overwrite = true;
      continue;
    }

    if (arg === "--force") {
      opts.force = true;
      opts.overwrite = true;
      continue;
    }

    if (arg === "--keep-root") {
      opts.keepRoot = true;
      continue;
    }

    if (arg === "-d" || arg === "--dest") {
      opts.dest = argv[++i] ?? "";
      if (!opts.dest) throw new Error("Missing destination after -d/--dest.");
      continue;
    }

    if (!opts.archive) {
      opts.archive = arg;
      continue;
    }

    if (!opts.dest) {
      opts.dest = arg;
      continue;
    }

    throw new Error(`Unexpected argument: ${arg}`);
  }

  if (!opts.archive && !opts.help) opts.archive = defaultZip();
  if (!opts.dest) opts.dest = process.cwd();
  return opts;
}

function run(cmd, args, extra = {}) {
  const result = spawnSync(cmd, args, {
    stdio: "inherit",
    shell: false,
    ...extra,
  });

  return result.status ?? 1;
}

function extractZipWindows(archivePath, tempDir) {
  const ps = commandExists("pwsh") ? "pwsh" : "powershell";

  const command = [
    "$ErrorActionPreference = 'Stop';",
    "New-Item -ItemType Directory -Force -Path $env:DEST | Out-Null;",
    "Expand-Archive -LiteralPath $env:ARCHIVE -DestinationPath $env:DEST -Force;",
  ].join(" ");

  const result = spawnSync(ps, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
    stdio: "inherit",
    shell: false,
    env: {
      ...process.env,
      ARCHIVE: archivePath,
      DEST: tempDir,
    },
  });

  return result.status ?? 1;
}

function extractZipUnix(archivePath, tempDir) {
  mkdirSync(tempDir, { recursive: true });

  if (commandExists("unzip")) return run("unzip", ["-q", "-o", archivePath, "-d", tempDir]);
  if (commandExists("bsdtar")) return run("bsdtar", ["-xf", archivePath, "-C", tempDir]);
  if (commandExists("python3")) return run("python3", ["-m", "zipfile", "-e", archivePath, tempDir]);

  throw new Error("No unzip tool found. Install unzip, bsdtar, or python3.");
}

function namesMatch(a, b) {
  if (process.platform === "win32") return String(a).toLowerCase() === String(b).toLowerCase();
  return String(a) === String(b);
}

function collapseRepeatedWrapperRoot(wrapperRoot, wrapperName) {
  let current = wrapperRoot;
  let nestedLevels = 0;

  while (true) {
    const entries = visibleEntries(current);
    if (entries.length !== 1) break;

    const childName = entries[0];
    if (!namesMatch(childName, wrapperName)) break;

    const child = join(current, childName);
    try {
      if (!statSync(child).isDirectory()) break;
    } catch {
      break;
    }

    current = child;
    nestedLevels++;
  }

  return { root: current, nestedLevels };
}

function repeatedWrapperSuffix(nestedLevels) {
  if (!nestedLevels) return "";
  return `; collapsed ${nestedLevels} nested duplicate wrapper${nestedLevels === 1 ? "" : "s"}`;
}

function resolveExtractPlan(tempDir, destPath, keepRoot = false) {
  const entries = visibleEntries(tempDir);

  if (keepRoot) {
    return {
      srcRoot: tempDir,
      destRoot: destPath,
      mode: "keep root folder",
    };
  }

  const topLevelDirs = entries.filter((name) => {
    try {
      return statSync(join(tempDir, name)).isDirectory();
    } catch {
      return false;
    }
  });

  // Wrapper detection is based on top-level directories, not total entries.
  // A ZIP may have one real wrapper directory plus sibling files such as
  // metadata or generated manifests. If that one directory does not match the
  // destination or an existing repo folder, flatten it before merging while
  // preserving the sibling files at the repo root.
  if (topLevelDirs.length === 1) {
    const rootName = topLevelDirs[0];
    const only = join(tempDir, rootName);
    const { root: contentRoot, nestedLevels } = collapseRepeatedWrapperRoot(only, rootName);
    const repeatedSuffix = repeatedWrapperSuffix(nestedLevels);
    const destinationMatches = namesMatch(basename(resolve(destPath)), rootName);
    const matchingDestFolder = join(destPath, rootName);
    const repoFolderMatches = directoryExists(matchingDestFolder);

    if (entries.length === 1) {
      if (destinationMatches) {
        return {
          srcRoot: contentRoot,
          destRoot: destPath,
          mode: `destination already matches wrapper: ${rootName}${repeatedSuffix}`,
        };
      }

      if (repoFolderMatches) {
        return {
          srcRoot: contentRoot,
          destRoot: matchingDestFolder,
          mode: `merge into existing folder: ${rootName}${repeatedSuffix}`,
        };
      }

      return {
        srcRoot: contentRoot,
        destRoot: destPath,
        mode: `strip wrapper folder: ${rootName}${repeatedSuffix}`,
      };
    }

    if (!destinationMatches && !repoFolderMatches) {
      mergeDirectoryContents(contentRoot, tempDir, { overwrite: false });
      rmSync(only, { recursive: true, force: true });
      return {
        srcRoot: tempDir,
        destRoot: destPath,
        mode: `strip unmatched wrapper folder: ${rootName} (preserve sibling files)${repeatedSuffix}`,
      };
    }
  }

  if (entries.length === 1) {
    return {
      srcRoot: tempDir,
      destRoot: destPath,
      mode: "single top-level file",
    };
  }

  return {
    srcRoot: tempDir,
    destRoot: destPath,
    mode: "merge multiple top-level entries",
  };
}

function listTopLevel(destPath) {
  try {
    return readdirSync(destPath)
      .slice(0, 30)
      .map((x) => `  - ${x}`)
      .join("\n");
  } catch {
    return "";
  }
}

function formatProtectedChanges(changes) {
  const shown = changes.slice(0, 20).map((item) => `  - ${item.relPath} (${item.reason})`);
  if (changes.length > shown.length) shown.push(`  ... and ${changes.length - shown.length} more`);
  return shown.join("\n");
}

export async function unzipMain(args) {
  const opts = parseArgs(args);
  if (opts.help) {
    usage();
    return;
  }

  const archivePath = resolve(opts.archive);
  const destPath = resolve(opts.dest);

  if (!existsSync(archivePath)) throw new Error(`Archive not found: ${archivePath}`);
  if (!statSync(archivePath).isFile()) throw new Error(`Not a file: ${archivePath}`);
  if (extname(archivePath).toLowerCase() !== ".zip") throw new Error(`Only .zip archives are supported: ${archivePath}`);

  const archiveSha256 = archiveFingerprint(archivePath);
  const tempDir = mkdtempSync(join(tmpdir(), "winflow-unzip-"));

  try {
    console.log(`Archive:    ${archivePath}`);
    console.log(`Destination: ${destPath}`);
    console.log(`Temp:       ${tempDir}`);

    const code = isWindows() ? extractZipWindows(archivePath, tempDir) : extractZipUnix(archivePath, tempDir);
    if (code !== 0) {
      throw new Error(`Unzip failed with exit code ${code}.`);
    }

    const plan = resolveExtractPlan(tempDir, destPath, opts.keepRoot);
    const incomingFiles = snapshotFiles(plan.srcRoot);
    const previous = readUnzipState(plan.destRoot);
    const sameArchive = previous?.archiveSha256 === archiveSha256;
    const sameLayout =
      previous &&
      Object.keys(previous.files ?? {}).sort().join("\n") === Object.keys(incomingFiles).sort().join("\n");
    const sameApplication = sameArchive && sameLayout;
    const localChanges = previous && sameArchive
      ? findChangedSinceSnapshot(plan.destRoot, previous.files ?? {}, incomingFiles)
      : [];

    console.log(`Mode:       ${plan.mode}`);
    console.log(`Merging:    ${plan.srcRoot}`);
    console.log(`Into:       ${plan.destRoot}`);

    if (sameApplication && !localChanges.length && !opts.force) {
      console.log("\nAlready applied. Destination files still match the previous extraction; nothing changed.");
      return;
    }

    if (sameArchive && localChanges.length && !opts.force) {
      throw new Error(
        `Refusing to overwrite ${localChanges.length} path(s) changed locally since the previous extraction:\n` +
          `${formatProtectedChanges(localChanges)}\n` +
          "Use --force only if you intentionally want to replace those local changes.",
      );
    }


    mergeDirectoryContents(plan.srcRoot, plan.destRoot, { overwrite: opts.overwrite });

    writeUnzipState(plan.destRoot, {
      archivePath,
      archiveSha256,
      extractedAt: new Date().toISOString(),
      files: incomingFiles,
    });

    console.log("\nDone.");
    if (opts.force) console.log("Warning: --force allowed destructive replacement of existing local content.");

    const preview = listTopLevel(plan.destRoot);
    if (preview) {
      console.log("\nDestination now contains:");
      console.log(preview);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
