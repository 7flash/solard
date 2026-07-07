import {
  boolValue,
  numberValue,
  optionalString,
  readJson,
  requireString,
  jsonResponse,
  errorResponse,
  assertWebAuth,
} from "../../../../src/web/http.js";
import { startPumpLaunchJob } from "../../../../src/web/launch-jobs.js";

function pushArg(argv: string[], key: string, value: unknown): void {
  if (value == null || value === "") return;
  if (value === false) return;
  argv.push(`--${key}`);
  if (value !== true) argv.push(String(value));
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertWebAuth(request);
    const body = await readJson(request);
    const argv: string[] = [];

    pushArg(argv, "creator", requireString(body, "creator"));
    pushArg(argv, "buyer-group", optionalString(body, "buyerGroup"));
    pushArg(argv, "metadata", optionalString(body, "metadataPath"));
    pushArg(argv, "alias", optionalString(body, "alias"));
    pushArg(argv, "name", optionalString(body, "name"));
    pushArg(argv, "symbol", optionalString(body, "symbol"));
    pushArg(argv, "uri", optionalString(body, "uri"));
    pushArg(argv, "image", optionalString(body, "imagePath"));
    pushArg(argv, "description", optionalString(body, "description"));
    pushArg(argv, "website", optionalString(body, "website"));
    pushArg(argv, "twitter", optionalString(body, "twitter"));
    pushArg(argv, "telegram", optionalString(body, "telegram"));

    pushArg(argv, "creator-buy-sol", optionalString(body, "creatorBuySol"));
    pushArg(argv, "buyer-min-bps", numberValue(body, "buyerMinBps", 5000));
    pushArg(argv, "buyer-max-bps", numberValue(body, "buyerMaxBps", 8000));
    pushArg(
      argv,
      "buyer-reserve-sol",
      optionalString(body, "buyerReserveSol") ?? "0.02",
    );
    pushArg(
      argv,
      "deployment-sender",
      optionalString(body, "deploymentSender") ?? "helius-rpc",
    );
    pushArg(
      argv,
      "buyer-sender",
      optionalString(body, "buyerSender") ?? "helius-fast",
    );
    pushArg(
      argv,
      "submit-mode",
      optionalString(body, "submitMode") ?? "fast-spam",
    );
    pushArg(argv, "sender-tps", numberValue(body, "senderTps", 40));
    pushArg(
      argv,
      "retry-interval-ms",
      numberValue(body, "retryIntervalMs", 75),
    );
    pushArg(
      argv,
      "retry-recompile-interval-ms",
      numberValue(body, "retryRecompileIntervalMs", 750),
    );
    pushArg(
      argv,
      "blockhash-refresh-interval-ms",
      numberValue(body, "blockhashRefreshIntervalMs", 500),
    );
    pushArg(
      argv,
      "fresh-quote-delay-ms",
      numberValue(body, "freshQuoteDelayMs", -1),
    );
    pushArg(argv, "retry-timeout-ms", numberValue(body, "retryTimeoutMs", 0));
    pushArg(
      argv,
      "max-failed-attempts",
      numberValue(body, "maxFailedAttempts", 0),
    );
    pushArg(
      argv,
      "rate-limit-backoff-ms",
      numberValue(body, "rateLimitBackoffMs", 400),
    );
    pushArg(argv, "retry-jitter-ms", numberValue(body, "retryJitterMs", 100));
    pushArg(
      argv,
      "helius-tip-sol",
      optionalString(body, "heliusTipSol") ?? "0.001",
    );
    pushArg(
      argv,
      "buyer-priority-micro-lamports",
      numberValue(body, "buyerPriorityMicroLamports", 1_500_000),
    );
    pushArg(
      argv,
      "deployment-priority-micro-lamports",
      numberValue(body, "deploymentPriorityMicroLamports", 0),
    );
    pushArg(argv, "slippage-bps", numberValue(body, "slippageBps", 9999));
    pushArg(argv, "out", optionalString(body, "out"));

    if (boolValue(body, "live", false)) pushArg(argv, "live", true);
    if (boolValue(body, "skipSimulation", true))
      pushArg(argv, "skip-simulation", true);

    const job = startPumpLaunchJob(argv);
    return jsonResponse({
      ok: true,
      value: { id: job.id, status: job.status, argv },
    });
  } catch (error) {
    return errorResponse(
      error,
      typeof (error as { status?: unknown }).status === "number"
        ? (error as { status: number }).status
        : 500,
    );
  }
}
