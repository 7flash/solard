export class JupiterHttpError extends Error {
  readonly name = "JupiterHttpError";

  constructor(
    readonly endpoint: "/order" | "/execute",
    readonly status: number,
    readonly detail?: string,
  ) {
    super(`Jupiter ${endpoint} HTTP ${status}${detail ? `: ${detail}` : ""}`);
  }
}

export class JupiterRouteError extends Error {
  readonly name = "JupiterRouteError";

  constructor(message: string) {
    super(message);
  }
}

export class JupiterExecutionError extends Error {
  readonly name = "JupiterExecutionError";

  constructor(
    readonly code: number,
    message: string,
  ) {
    super(`Jupiter swap failed (code ${code}): ${message}`);
  }
}
