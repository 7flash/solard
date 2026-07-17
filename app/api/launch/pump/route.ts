import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  assertWebAuth,
  errorResponse,
  jsonResponse,
  readJson,
} from "../../../../src/web/http.js";
import { pumpLaunchInputFromRecord } from "../../../../src/solard/actions/index.js";
import { authorizePumpLaunchJobLive } from "../../../../src/solard/actions/launches.js";
import {
  LAUNCH_JOB_RUNNER_VERSION,
  startPumpLaunchJob,
} from "../../../../src/solard/jobs/launch-job-store.js";

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

const IMAGE_EXTENSION: Record<string, string> = {
  "image/png": "png",

  "image/jpeg": "jpg",

  "image/webp": "webp",

  "image/gif": "gif",
};

function isUploadedFile(value: FormDataEntryValue | null): value is File {
  return Boolean(
    value &&
    typeof value !== "string" &&
    typeof value.arrayBuffer === "function",
  );
}

function stringRecord(form: FormData): Record<string, unknown> {
  const body: Record<string, unknown> = {};

  for (const [key, value] of form.entries()) {
    if (typeof value === "string") {
      body[key] = value;
    }
  }

  const buyPlanJson =
    typeof body.buyPlanJson === "string" ? body.buyPlanJson : "";

  if (buyPlanJson) {
    let parsed: unknown;

    try {
      parsed = JSON.parse(buyPlanJson);
    } catch {
      throw Object.assign(new Error("buyPlanJson must be valid JSON."), {
        status: 400,
      });
    }

    if (!Array.isArray(parsed)) {
      throw Object.assign(new Error("buyPlanJson must contain an array."), {
        status: 400,
      });
    }

    body.buyPlan = parsed;

    delete body.buyPlanJson;
  }

  const name = String(body.name ?? "").trim();

  const symbol = String(body.symbol ?? "").trim();

  if (!body.alias) {
    body.alias =
      (symbol || name)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48) || `token-${Date.now()}`;
  }

  if (!body.mintSuffix) {
    body.mintSuffix = "pump";
  }

  return body;
}

function badRequest(message: string): never {
  throw Object.assign(new Error(message), { status: 400 });
}

function finiteNumber(
  value: unknown,
  label: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    badRequest(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function buyPlanFromBody(body: Record<string, unknown>): unknown[] {
  if (Array.isArray(body.buyPlan)) return body.buyPlan;
  if (typeof body.buyPlanJson !== "string" || !body.buyPlanJson.trim())
    return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.buyPlanJson);
  } catch {
    badRequest("buyPlanJson must be valid JSON.");
  }
  if (!Array.isArray(parsed)) badRequest("buyPlanJson must contain an array.");
  return parsed;
}

function normalizeJitoBuyPlan(
  body: Record<string, unknown>,
): Record<string, unknown>[] {
  const rows = buyPlanFromBody(body);
  if (rows.length < 1 || rows.length > 4) {
    badRequest(
      "An ordered Jito launch requires between one and four buyer wallets.",
    );
  }

  const creator = String(body.creator ?? "")
    .trim()
    .toLowerCase();
  const seen = new Set<string>();

  return rows.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      badRequest(`Buyer ${index + 1} must be an object.`);
    }
    const row = value as Record<string, unknown>;
    const wallet = String(
      row.wallet ?? row.walletAddress ?? row.address ?? "",
    ).trim();
    if (!wallet) badRequest(`Buyer ${index + 1} wallet is required.`);

    const normalized = wallet.toLowerCase();
    if (creator && normalized === creator) {
      badRequest(`Buyer ${index + 1} cannot use the deployer wallet.`);
    }
    if (seen.has(normalized)) {
      badRequest(`Buyer wallet ${wallet} appears more than once.`);
    }
    seen.add(normalized);

    const minBps = Math.round(
      finiteNumber(row.minBps, `Buyer ${index + 1} minBps`, 5_000, 0, 10_000),
    );
    const maxBps = Math.round(
      finiteNumber(row.maxBps, `Buyer ${index + 1} maxBps`, 8_000, 0, 10_000),
    );
    if (minBps > maxBps) {
      badRequest(`Buyer ${index + 1} minBps cannot exceed maxBps.`);
    }

    const reserveSol = String(row.reserveSol ?? "0.02").trim();
    finiteNumber(
      reserveSol,
      `Buyer ${index + 1} reserveSol`,
      0.02,
      0,
      1_000_000,
    );

    return {
      wallet,
      label:
        typeof row.label === "string" && row.label.trim()
          ? row.label.trim().slice(0, 120)
          : `Buyer ${index + 1}`,
      amountMode: "range-bps",
      minBps,
      maxBps,
      reserveSol,
      cuLimit: Math.round(
        finiteNumber(
          row.cuLimit,
          `Buyer ${index + 1} cuLimit`,
          600_000,
          1,
          1_400_000,
        ),
      ),
      priorityMicroLamports: Math.round(
        finiteNumber(
          row.priorityMicroLamports,
          `Buyer ${index + 1} priorityMicroLamports`,
          1_000_000,
          0,
          Number.MAX_SAFE_INTEGER,
        ),
      ),
      slippageBps: Math.round(
        finiteNumber(
          row.slippageBps,
          `Buyer ${index + 1} slippageBps`,
          2_500,
          0,
          10_000,
        ),
      ),
    };
  });
}

function forceOrderedJitoLaunch(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = { ...body };
  normalized.buyPlan = normalizeJitoBuyPlan(normalized);
  delete normalized.buyPlanJson;

  // The browser selects wallets and amounts. Transport, endpoint, and tip policy
  // remain server-owned and are resolved by the same launch core used by the CLI.
  normalized.submitMode = "jito-bundle";
  normalized.skipSimulation = true;
  normalized.live = true;

  for (const key of [
    "deploymentSender",
    "buyerSender",
    "heliusTipSol",
    "rpcUrl",
    "jitoBlockEngineUrl",
    "jitoTipAccount",
    "jitoTipMode",
    "jitoTipSol",
    "jitoTipPercentile",
    "jitoTipMultiplier",
    "jitoTipMinSol",
    "jitoTipMaxSol",
    "jitoTipFloorUrl",
    "jitoTipFloorMaxAgeMs",
  ]) {
    delete normalized[key];
  }

  return normalized;
}

async function saveLaunchImage(file: File): Promise<string> {
  const extension = IMAGE_EXTENSION[file.type];

  if (!extension) {
    throw Object.assign(
      new Error("Token image must be PNG, JPG, WEBP, or GIF."),
      {
        status: 400,
      },
    );
  }

  if (file.size <= 0 || file.size > MAX_IMAGE_BYTES) {
    throw Object.assign(
      new Error("Token image must be between 1 byte and 12 MB."),
      {
        status: 400,
      },
    );
  }

  const directory = resolve(
    process.env.SOLARD_LAUNCH_UPLOAD_DIR?.trim() || "./.solard/launch-uploads",
  );

  await mkdir(directory, {
    recursive: true,
  });

  const path = resolve(directory, `${Date.now()}-${randomUUID()}.${extension}`);

  await writeFile(path, Buffer.from(await file.arrayBuffer()));

  return path;
}

async function requestBody(request: Request): Promise<{
  body: Record<string, unknown>;

  temporaryImagePath: string | null;
}> {
  const contentType = request.headers.get("content-type") ?? "";

  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    return {
      body: await readJson(request),

      temporaryImagePath: null,
    };
  }

  const form = await request.formData();

  const image = form.get("image");

  if (!isUploadedFile(image)) {
    throw Object.assign(new Error("Token image is required."), {
      status: 400,
    });
  }

  const temporaryImagePath = await saveLaunchImage(image);

  const body = stringRecord(form);

  body.imagePath = temporaryImagePath;

  body.temporaryImagePath = temporaryImagePath;

  return {
    body,
    temporaryImagePath,
  };
}

function validateLaunchInput(
  input: ReturnType<typeof pumpLaunchInputFromRecord>,
): void {
  const required: Array<[string, string | null | undefined]> = [
    ["deployer wallet", input.creator],
    ["token name", input.name],
    ["token symbol", input.symbol],
  ];

  for (const [label, value] of required) {
    if (!value?.trim()) {
      throw Object.assign(new Error(`${label} is required.`), {
        status: 400,
      });
    }
  }

  if (
    !input.uri &&
    !input.metadataPath &&
    (!input.imagePath || !input.description?.trim())
  ) {
    throw Object.assign(
      new Error("Upload an image and provide a description."),
      {
        status: 400,
      },
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  let temporaryImagePath: string | null = null;

  try {
    assertWebAuth(request);

    const parsed = await requestBody(request);

    temporaryImagePath = parsed.temporaryImagePath;

    const input = pumpLaunchInputFromRecord(
      forceOrderedJitoLaunch(parsed.body),
    );

    validateLaunchInput(input);

    /**
     * Non-enumerable internal capability. It is not accepted from request
     * JSON/FormData and is not written into launch history.
     *
     * This also protects against any stale compatibility caller that still
     * reaches launchPumpTokenAction().
     */
    authorizePumpLaunchJobLive(input);

    const job = startPumpLaunchJob(input);

    /**
     * The background launch job owns cleanup after this point.
     */
    temporaryImagePath = null;

    return jsonResponse({
      ok: true,

      value: {
        id: job.id,

        status: job.status,

        runnerVersion: LAUNCH_JOB_RUNNER_VERSION,
      },
    });
  } catch (error) {
    if (temporaryImagePath) {
      await unlink(temporaryImagePath).catch(() => undefined);
    }

    return errorResponse(
      error,
      typeof (
        error as {
          status?: unknown;
        }
      ).status === "number"
        ? (
            error as {
              status: number;
            }
          ).status
        : 500,
    );
  }
}
