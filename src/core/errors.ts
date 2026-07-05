export class SowlError extends Error {
  constructor(
    message: string,
    readonly code = "SOWL_ERROR",
    readonly causeValue?: unknown,
  ) {
    super(message, { cause: causeValue });
    this.name = new.target.name;
  }
}
export class MissingConfigError extends SowlError {
  constructor(name: string) {
    super(`Missing configuration: ${name}`, "MISSING_CONFIG");
  }
}
export class UnknownWalletError extends SowlError {
  constructor(ref: string) {
    super(`Unknown wallet: ${ref}`, "UNKNOWN_WALLET");
  }
}
export class WalletCannotSignError extends SowlError {
  constructor(address: string) {
    super(
      `Wallet ${address} is not backed by an imported signing key`,
      "WALLET_CANNOT_SIGN",
    );
  }
}
export class UnknownTokenError extends SowlError {
  constructor(ref: string) {
    super(
      `Unknown token: ${ref}. Register it first with sowl token <mint> [name].`,
      "UNKNOWN_TOKEN",
    );
  }
}
export class UnsupportedTokenError extends SowlError {
  constructor(mint: string) {
    super(`No registered venue can route token ${mint}`, "UNSUPPORTED_TOKEN");
  }
}
export class QuoteAssetMismatchError extends SowlError {
  constructor(claimMint: string, buyMint: string) {
    super(
      `Claim quote asset ${claimMint} cannot fund a buy quoted in ${buyMint} inside one transaction`,
      "QUOTE_ASSET_MISMATCH",
    );
  }
}
export class UnknownLaunchSourceError extends SowlError {
  constructor(id: string) {
    super(`Unknown launch source: ${id}`, "UNKNOWN_LAUNCH_SOURCE");
  }
}
export class UnknownLaunchpadError extends SowlError {
  constructor(id: string) {
    super(`Unknown token launchpad: ${id}`, "UNKNOWN_LAUNCHPAD");
  }
}
export class LaunchTimeoutError extends SowlError {
  constructor(source: string, timeoutMs: number) {
    super(
      `Timed out after ${timeoutMs}ms waiting for a token from ${source}`,
      "LAUNCH_TIMEOUT",
    );
  }
}
export class TransactionTooLargeError extends SowlError {
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
export class SimulationFailedError extends SowlError {
  constructor(logs: readonly string[], error: unknown) {
    super(
      `Transaction simulation failed: ${JSON.stringify(error)}\n${logs.join("\n")}`,
      "SIMULATION_FAILED",
    );
  }
}
