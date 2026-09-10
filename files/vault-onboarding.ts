import {
  createCipheriv,
  createDecipheriv,
  pbkdf2Sync,
  randomBytes,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

const VAULT_VERSION = 1 as const;
const KDF_ITERATIONS = 310_000;
const MASTER_KEY_BYTES = 32;

export class VaultOnboardingError extends Error {
  readonly name = "VaultOnboardingError";
}

type VaultConfig = {
  version: 1;
  createdAt: string;
  kdf: "pbkdf2-sha256";
  iterations: number;
  salt: string;
  wrapNonce: string;
  wrapAuthTag: string;
  wrappedMasterKey: string;
  remember: "windows-dpapi" | "password";
  protectedMasterKey?: string;
};

export type VaultReadyResult = {
  source: "env" | "windows-dpapi" | "password" | "created";
  created: boolean;
  remembered: boolean;
  path: string;
};

function vaultPath(): string {
  return (
    process.env.SLRD_VAULT_PATH?.trim() ||
    join(homedir(), ".solard", "vault.json")
  );
}

function readConfig(path = vaultPath()): VaultConfig | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new VaultOnboardingError(
      `Local vault profile is unreadable: ${path}\n${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new VaultOnboardingError(`Local vault profile is invalid: ${path}`);
  }
  const row = parsed as Partial<VaultConfig>;
  if (
    row.version !== VAULT_VERSION ||
    row.kdf !== "pbkdf2-sha256" ||
    !Number.isInteger(row.iterations) ||
    Number(row.iterations) < 100_000 ||
    typeof row.salt !== "string" ||
    typeof row.wrapNonce !== "string" ||
    typeof row.wrapAuthTag !== "string" ||
    typeof row.wrappedMasterKey !== "string" ||
    (row.remember !== "windows-dpapi" && row.remember !== "password")
  ) {
    throw new VaultOnboardingError(
      `Local vault profile has an unsupported format: ${path}`,
    );
  }
  return row as VaultConfig;
}

function writeConfig(config: VaultConfig, path = vaultPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // Windows ACLs are authoritative. chmod is best-effort there.
  }
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort on filesystems without POSIX permission support.
  }
}

function deriveWrappingKey(
  password: string,
  config: Pick<VaultConfig, "salt" | "iterations">,
): Buffer {
  return pbkdf2Sync(
    password,
    Buffer.from(config.salt, "base64"),
    config.iterations,
    32,
    "sha256",
  );
}

function wrapMasterKey(
  masterKey: string,
  password: string,
  salt: Buffer,
): Pick<
  VaultConfig,
  "iterations" | "salt" | "wrapNonce" | "wrapAuthTag" | "wrappedMasterKey"
> {
  const iterations = KDF_ITERATIONS;
  const key = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(masterKey, "utf8")),
    cipher.final(),
  ]);
  return {
    iterations,
    salt: salt.toString("base64"),
    wrapNonce: nonce.toString("base64"),
    wrapAuthTag: cipher.getAuthTag().toString("base64"),
    wrappedMasterKey: encrypted.toString("base64"),
  };
}

function unwrapMasterKey(config: VaultConfig, password: string): string {
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      deriveWrappingKey(password, config),
      Buffer.from(config.wrapNonce, "base64"),
    );
    decipher.setAuthTag(Buffer.from(config.wrapAuthTag, "base64"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(config.wrappedMasterKey, "base64")),
      decipher.final(),
    ]).toString("utf8");
    if (!plain) throw new Error("empty master key");
    return plain;
  } catch {
    throw new VaultOnboardingError("That vault password is not correct.");
  }
}

function powershell(): string | null {
  if (process.platform !== "win32") return null;
  for (const executable of ["powershell.exe", "pwsh.exe"]) {
    const probe = spawnSync(
      executable,
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$PSVersionTable.PSVersion.Major",
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 5_000,
      },
    );
    if (probe.status === 0) return executable;
  }
  return null;
}

function dpapiProtect(masterKey: string): string | null {
  const shell = powershell();
  if (!shell) return null;
  const script = [
    "$inputText = [Console]::In.ReadToEnd().Trim()",
    "$plain = [Convert]::FromBase64String($inputText)",
    "$protected = [System.Security.Cryptography.ProtectedData]::Protect($plain, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Console]::Out.Write([Convert]::ToBase64String($protected))",
  ].join("; ");
  const result = spawnSync(
    shell,
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      input: Buffer.from(masterKey, "utf8").toString("base64"),
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    },
  );
  const value = result.status === 0 ? result.stdout.trim() : "";
  return value || null;
}

function dpapiUnprotect(protectedValue: string): string | null {
  const shell = powershell();
  if (!shell) return null;
  const script = [
    "$inputText = [Console]::In.ReadToEnd().Trim()",
    "$protected = [Convert]::FromBase64String($inputText)",
    "$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($protected, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Console]::Out.Write([Convert]::ToBase64String($plain))",
  ].join("; ");
  const result = spawnSync(
    shell,
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      input: protectedValue,
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    },
  );
  if (result.status !== 0 || !result.stdout.trim()) return null;
  try {
    return Buffer.from(result.stdout.trim(), "base64").toString("utf8") || null;
  } catch {
    return null;
  }
}

async function promptLine(message: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new VaultOnboardingError(
      "Interactive vault setup needs a terminal. Run `slrd setup` in a terminal or provide SLRD_MASTER_KEY.",
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(message)).trim();
  } finally {
    rl.close();
  }
}

async function promptHidden(message: string): Promise<string> {
  const input = process.stdin;
  if (
    !input.isTTY ||
    !process.stdout.isTTY ||
    typeof input.setRawMode !== "function"
  ) {
    throw new VaultOnboardingError(
      "Interactive password entry needs a terminal. Run `slrd setup` in a terminal or provide SLRD_MASTER_KEY.",
    );
  }

  process.stdout.write(message);
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");

  return await new Promise<string>((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode(Boolean(wasRaw));
      input.pause();
      process.stdout.write("\n");
    };
    const onData = (chunk: string | Buffer) => {
      const text = String(chunk);
      for (const ch of text) {
        if (ch === "\u0003") {
          cleanup();
          reject(new VaultOnboardingError("Vault setup cancelled."));
          return;
        }
        if (ch === "\r" || ch === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (ch >= " ") value += ch;
      }
    };
    input.on("data", onData);
  });
}

function banner(): string {
  return [
    "",
    "╭──────────────────────────────────────────────────────╮",
    "│                    🦉  SOLARD                       │",
    "│                  Local wallet vault                 │",
    "╰──────────────────────────────────────────────────────╯",
    "",
    "Solard encrypts every persisted signing key before it is written to disk.",
    "Choose a vault password now. The password itself is never stored.",
    "",
  ].join("\n");
}

async function newPassword(): Promise<string> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const first = await promptHidden("Create vault password: ");
    if (first.length < 8) {
      process.stdout.write("Password must be at least 8 characters.\n\n");
      continue;
    }
    const second = await promptHidden("Confirm password:      ");
    if (first !== second) {
      process.stdout.write("Passwords did not match. Try again.\n\n");
      continue;
    }
    return first;
  }
  throw new VaultOnboardingError(
    "Could not create the vault after 3 attempts.",
  );
}

async function unlockWithPassword(config: VaultConfig): Promise<string> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const password = await promptHidden("Vault password: ");
    try {
      return unwrapMasterKey(config, password);
    } catch (error) {
      if (attempt === 3) throw error;
      process.stdout.write("Incorrect password. Try again.\n\n");
    }
  }
  throw new VaultOnboardingError("Unable to unlock the vault.");
}

function setMasterKey(value: string): void {
  process.env.SLRD_MASTER_KEY = value;
}

export function loadRememberedCliVault(): VaultReadyResult | null {
  const path = vaultPath();
  if (process.env.SLRD_MASTER_KEY?.trim()) {
    return { source: "env", created: false, remembered: false, path };
  }
  const config = readConfig(path);
  if (
    !config ||
    config.remember !== "windows-dpapi" ||
    !config.protectedMasterKey
  ) {
    return null;
  }
  const masterKey = dpapiUnprotect(config.protectedMasterKey);
  if (!masterKey) return null;
  setMasterKey(masterKey);
  return { source: "windows-dpapi", created: false, remembered: true, path };
}

export async function ensureCliVaultReady(options: {
  existingWalletCount: number;
  allowCreate?: boolean;
  adoptEnvironment?: boolean;
}): Promise<VaultReadyResult> {
  const path = vaultPath();
  const config = readConfig(path);
  const envMasterKey = process.env.SLRD_MASTER_KEY?.trim();

  // Explicit adoption is the one case where an environment key must not short-circuit
  // setup: we are intentionally wrapping that exact legacy key into the local vault.
  if (options.adoptEnvironment && envMasterKey && !config) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new VaultOnboardingError(
        "Adopting SLRD_MASTER_KEY needs an interactive terminal so a recovery password can be created.",
      );
    }
    process.stdout.write(banner());
    process.stdout.write(
      "An existing SLRD_MASTER_KEY is active. Solard can wrap that same key in the local vault,\n" +
        "so existing encrypted wallets keep working and you no longer need to set the environment variable.\n\n",
    );
    const password = await newPassword();
    const wrapped = wrapMasterKey(envMasterKey, password, randomBytes(16));
    const protectedMasterKey =
      process.platform === "win32" ? dpapiProtect(envMasterKey) : null;
    const next: VaultConfig = {
      version: VAULT_VERSION,
      createdAt: new Date().toISOString(),
      kdf: "pbkdf2-sha256",
      ...wrapped,
      remember: protectedMasterKey ? "windows-dpapi" : "password",
      ...(protectedMasterKey ? { protectedMasterKey } : {}),
    };
    writeConfig(next, path);
    return {
      source: "env",
      created: true,
      remembered: Boolean(protectedMasterKey),
      path,
    };
  }

  const remembered = loadRememberedCliVault();
  if (remembered) return remembered;

  if (config) {
    const masterKey = await unlockWithPassword(config);
    setMasterKey(masterKey);
    return {
      source: "password",
      created: false,
      remembered: false,
      path,
    };
  }

  if (envMasterKey) {
    return { source: "env", created: false, remembered: false, path };
  }

  if (options.adoptEnvironment) {
    throw new VaultOnboardingError(
      "--adopt-env requires SLRD_MASTER_KEY to be set in this shell.",
    );
  }

  if (options.existingWalletCount > 0) {
    throw new VaultOnboardingError(
      [
        `Found ${options.existingWalletCount} existing encrypted wallet(s), but no local vault profile or SLRD_MASTER_KEY.`,
        "",
        "Do not create a new vault key: it would not decrypt those wallets.",
        "Restore the SLRD_MASTER_KEY that was used when they were created, then run:",
        "  slrd setup --adopt-env",
      ].join("\n"),
    );
  }

  if (options.allowCreate === false) {
    throw new VaultOnboardingError(
      "No local wallet vault is configured. Run `slrd setup` first.",
    );
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new VaultOnboardingError(
      "No wallet vault is configured. Run `slrd setup` interactively, or set SLRD_MASTER_KEY for automation/CI.",
    );
  }

  process.stdout.write(banner());
  process.stdout.write(
    process.platform === "win32"
      ? "On Windows, Solard will remember the unlocked vault for this Windows user using DPAPI.\n" +
          "Your password remains the recovery path if you move the database to another machine.\n\n"
      : "This platform will ask for the vault password when a command needs a signing key.\n\n",
  );

  const password = await newPassword();
  const masterKey = randomBytes(MASTER_KEY_BYTES).toString("base64url");
  const wrapped = wrapMasterKey(masterKey, password, randomBytes(16));
  let protectedMasterKey: string | null = null;

  if (process.platform === "win32") {
    const answer = (
      await promptLine("Remember unlock on this Windows account? [Y/n] ")
    ).toLowerCase();
    if (answer === "" || answer === "y" || answer === "yes") {
      protectedMasterKey = dpapiProtect(masterKey);
      if (!protectedMasterKey) {
        process.stdout.write(
          "Could not use Windows DPAPI, so Solard will ask for the password when signing is needed.\n",
        );
      }
    }
  }

  const next: VaultConfig = {
    version: VAULT_VERSION,
    createdAt: new Date().toISOString(),
    kdf: "pbkdf2-sha256",
    ...wrapped,
    remember: protectedMasterKey ? "windows-dpapi" : "password",
    ...(protectedMasterKey ? { protectedMasterKey } : {}),
  };
  writeConfig(next, path);
  setMasterKey(masterKey);

  process.stdout.write(
    "\n✓ Vault created\n" +
      `  profile: ${path}\n` +
      `  unlock:  ${protectedMasterKey ? "remembered for this Windows user" : "password required when signing"}\n` +
      "\nKeep your vault password safe. Back up both ~/.solard/solard.sqlite and ~/.solard/vault.json.\n\n",
  );

  return {
    source: "created",
    created: true,
    remembered: Boolean(protectedMasterKey),
    path,
  };
}

export function cliVaultStatus(): {
  path: string;
  configured: boolean;
  environmentOverride: boolean;
  remembered: boolean;
  platform: NodeJS.Platform;
} {
  const path = vaultPath();
  const config = readConfig(path);
  return {
    path,
    configured: config !== null,
    environmentOverride: Boolean(process.env.SLRD_MASTER_KEY?.trim()),
    remembered:
      config?.remember === "windows-dpapi" &&
      Boolean(config.protectedMasterKey),
    platform: process.platform,
  };
}
