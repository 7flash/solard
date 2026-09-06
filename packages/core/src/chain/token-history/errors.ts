export type TokenHistoryErrorCode =
  | "INVALID_INPUT"
  | "UNSUPPORTED_TOKEN"
  | "RPC_TIMEOUT"
  | "RPC_FAILED"
  | "INCOMPLETE_HISTORY"
  | "PERSISTENCE_FAILED";

export type TokenHistoryErrorContext = Record<
  string,
  string | number | boolean | null | undefined
>;

export class TokenHistoryError extends Error {
  readonly name = "TokenHistoryError";

  constructor(
    readonly code: TokenHistoryErrorCode,
    message: string,
    readonly options: {
      stage?: string;
      recoverable?: boolean;
      context?: TokenHistoryErrorContext;
      cause?: unknown;
    } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
  }
}

export function tokenHistoryError(
  error: unknown,
  fallback: {
    code: TokenHistoryErrorCode;
    message: string;
    stage?: string;
    recoverable?: boolean;
    context?: TokenHistoryErrorContext;
  },
): TokenHistoryError {
  if (error instanceof TokenHistoryError) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return new TokenHistoryError(
    fallback.code,
    `${fallback.message}: ${detail}`,
    {
      stage: fallback.stage,
      recoverable: fallback.recoverable,
      context: fallback.context,
      cause: error,
    },
  );
}
