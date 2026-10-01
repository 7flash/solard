export class SolardError extends Error {
  constructor(
    message: string,
    readonly code = "SLRD_ERROR",
    readonly causeValue?: unknown,
  ) {
    super(message, { cause: causeValue });
    this.name = new.target.name;
  }
}
export class MissingConfigError extends SolardError {
  constructor(name: string) {
    super(`Missing configuration: ${name}`, "MISSING_CONFIG");
  }
}
export class UnknownWalletError extends SolardError {
  constructor(ref: string) {
    super(`Unknown wallet: ${ref}`, "UNKNOWN_WALLET");
  }
}
export class WalletCannotSignError extends SolardError {
  constructor(address: string) {
    super(
      `Wallet ${address} is not backed by an imported signing key`,
      "WALLET_CANNOT_SIGN",
    );
  }
}
export class UnknownTokenError extends SolardError {
  constructor(ref: string) {
    super(
      `Unknown token: ${ref}. Register it first with slrd token <mint> [name].`,
      "UNKNOWN_TOKEN",
    );
  }
}
export class UnsupportedTokenError extends SolardError {
  constructor(mint: string) {
    super(`No registered venue can route token ${mint}`, "UNSUPPORTED_TOKEN");
  }
}
export class QuoteAssetMismatchError extends SolardError {
  constructor(claimMint: string, buyMint: string) {
    super(
      `Claim quote asset ${claimMint} cannot fund a buy quoted in ${buyMint} inside one transaction`,
      "QUOTE_ASSET_MISMATCH",
    );
  }
}
export class UnknownLaunchSourceError extends SolardError {
  constructor(id: string) {
    super(`Unknown launch source: ${id}`, "UNKNOWN_LAUNCH_SOURCE");
  }
}
export class UnknownLaunchpadError extends SolardError {
  constructor(id: string) {
    super(`Unknown token launchpad: ${id}`, "UNKNOWN_LAUNCHPAD");
  }
}
export class LaunchTimeoutError extends SolardError {
  constructor(source: string, timeoutMs: number) {
    super(
      `Timed out after ${timeoutMs}ms waiting for a token from ${source}`,
      "LAUNCH_TIMEOUT",
    );
  }
}
export class TransactionTooLargeError extends SolardError {
  readonly lookupCandidates: string[];
  constructor(
    size: number | null,
    activeAltCount = 0,
    lookupCandidates: string[] = [],
  ) {
    const measured =
      size == null
        ? "before serialization (message buffer overflowed)"
        : `to ${size} bytes`;
    const advice =
      activeAltCount === 0
        ? " Create and extend an address lookup table for this settlement before retrying."
        : " Extend the registered address lookup table with the settlement accounts before retrying.";
    super(
      `Transaction is too large ${measured}; Solana packet limit is 1232 bytes.${advice}`,
      "TRANSACTION_TOO_LARGE",
    );
    this.lookupCandidates = lookupCandidates;
  }
}
export class SimulationFailedError extends SolardError {
  constructor(logs: readonly string[], error: unknown) {
    super(
      `Transaction simulation failed: ${JSON.stringify(error)}\n${logs.join("\n")}`,
      "SIMULATION_FAILED",
    );
  }
}


const DEFINITIVE_PRE_SUBMISSION_CODES = new Set([
  "MISSING_CONFIG",
  "UNKNOWN_WALLET",
  "WALLET_CANNOT_SIGN",
  "UNKNOWN_TOKEN",
  "UNSUPPORTED_TOKEN",
  "QUOTE_ASSET_MISMATCH",
  "TRANSACTION_TOO_LARGE",
  "SIMULATION_FAILED",
]);

/** True only when Solard can prove no transaction was submitted. */
export function isDefinitivePreSubmissionError(error: unknown): boolean {
  if (error && typeof error === "object" && "phase" in error && error.phase === "before-submission") return true;
  if (error instanceof SolardError && DEFINITIVE_PRE_SUBMISSION_CODES.has(error.code))
    return true;
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  if (DEFINITIVE_PRE_SUBMISSION_CODES.has(code)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /simulation failed|transaction simulation failed|custom program error|insufficient funds|invalid transaction|invalid account|blockhash not found/i.test(
    message,
  );
}
