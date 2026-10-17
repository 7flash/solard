import { spawnSync } from "node:child_process";
for (const name of ["core", "sdk", "cli"]) {
  const result = spawnSync("bun", ["run", "typecheck"], { cwd: "packages/" + name, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
