export class VaultOnboardingError extends Error {
  readonly name: string = "VaultOnboardingError";
}

export class VaultIntegrityError extends VaultOnboardingError {
  readonly name: string = "VaultIntegrityError";
}

export type VaultReadyResult = {
  source: "env" | "interactive" | "interactive-created";
  created: boolean;
  remembered: false;
  persisted: false;
};

function interactive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function promptHidden(message: string): Promise<string> {
  const input = process.stdin;
  if (!interactive() || typeof input.setRawMode !== "function") {
    throw new VaultOnboardingError(
      "This command needs a wallet password, but stdin is not interactive. " +
        "Set SLRD_MASTER_KEY for CI/server automation or run the command in a terminal.",
    );
  }

  process.stdout.write(message);
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");

  return await new Promise<string>((resolve, reject) => {
    let value = "";
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      input.off("data", onData);
      input.setRawMode(Boolean(wasRaw));
      input.pause();
      process.stdout.write("\n");
    };
    const onData = (chunk: string | Buffer) => {
      for (const ch of String(chunk)) {
        if (ch === "\u0003") {
          cleanup();
          reject(new VaultOnboardingError("Password entry cancelled."));
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

function setMasterKey(value: string): void {
  process.env.SLRD_MASTER_KEY = value;
}

function clearMasterKey(): void {
  delete process.env.SLRD_MASTER_KEY;
}

function environmentMasterKey(): string | null {
  const value = process.env.SLRD_MASTER_KEY;
  return value != null && value.length > 0 ? value : null;
}

async function confirmNewPassword(): Promise<string> {
  process.stdout.write(
    [
      "",
      "╭──────────────────────────────────────────────────────╮",
      "│                    🦉  SOLARD                       │",
      "│               Encrypted local wallets               │",
      "╰──────────────────────────────────────────────────────╯",
      "",
      "Your wallet secret keys are encrypted before they are stored.",
      "Solard does NOT save this password. You will enter it again in a future",
      "terminal session unless SLRD_MASTER_KEY is explicitly set in the environment.",
      "",
    ].join("\n"),
  );

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const first = await promptHidden("Create wallet password: ");
    if (first.length < 8) {
      process.stdout.write("Use at least 8 characters.\n\n");
      continue;
    }
    const second = await promptHidden("Confirm password:       ");
    if (first !== second) {
      process.stdout.write("Passwords did not match. Try again.\n\n");
      continue;
    }
    return first;
  }
  throw new VaultOnboardingError(
    "Could not confirm a wallet password after 3 attempts.",
  );
}

async function validateAllStoredWallets(password: string): Promise<void> {
  setMasterKey(password);
  const { createTraderSolard } = await import("@solard/core");
  const probe = createTraderSolard();
  try {
    const integrity = probe.wallets.integrity();
    if (!integrity.failures.length) return;
    clearMasterKey();
    if (integrity.decrypted === 0) {
      throw new VaultOnboardingError(
        "That wallet password could not decrypt the stored wallet database.",
      );
    }
    const affected = integrity.failures
      .map((wallet) => `@${wallet.name} ${wallet.address}`)
      .join(", ");
    throw new VaultIntegrityError(
      `Wallet database integrity check failed: one master password must decrypt every stored signing wallet. ` +
        `Decrypted ${integrity.decrypted}/${integrity.total}; undecryptable or mismatched: ${affected}`,
    );
  } finally {
    probe.close();
  }
}

async function unlockExistingWallets(): Promise<string> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const password = await promptHidden("Wallet password: ");
    try {
      await validateAllStoredWallets(password);
      return password;
    } catch (error) {
      if (error instanceof VaultIntegrityError) throw error;
      if (attempt === 3) throw error;
      process.stdout.write("Incorrect password. Try again.\n\n");
    }
  }
  throw new VaultOnboardingError("Unable to unlock the stored wallets.");
}

export async function ensureCliVaultReady(options: {
  existingWalletCount: number;
  allowCreate?: boolean;
}): Promise<VaultReadyResult> {
  const existing = environmentMasterKey();
  if (existing) {
    await validateAllStoredWallets(existing);
    return {
      source: "env",
      created: false,
      remembered: false,
      persisted: false,
    };
  }

  if (!interactive()) {
    throw new VaultOnboardingError(
      "This command needs a wallet password. Run it in an interactive terminal, " +
        "or set SLRD_MASTER_KEY for CI/server automation.",
    );
  }

  if (options.existingWalletCount > 0) {
    await unlockExistingWallets();
    return {
      source: "interactive",
      created: false,
      remembered: false,
      persisted: false,
    };
  }

  if (options.allowCreate === false) {
    throw new VaultOnboardingError(
      "No stored signing wallet exists yet. Create one with `slrd wallet create [name]`.",
    );
  }

  const password = await confirmNewPassword();
  setMasterKey(password);
  return {
    source: "interactive-created",
    created: true,
    remembered: false,
    persisted: false,
  };
}

export function cliVaultStatus(): {
  mode: "ephemeral-password";
  environmentOverride: boolean;
  passwordPersisted: false;
  remembered: false;
} {
  return {
    mode: "ephemeral-password",
    environmentOverride: environmentMasterKey() != null,
    passwordPersisted: false,
    remembered: false,
  };
}

export async function promptForWalletPassword(
  existingWalletCount: number,
): Promise<void> {
  await ensureCliVaultReady({
    existingWalletCount,
    allowCreate: existingWalletCount === 0,
  });
}
