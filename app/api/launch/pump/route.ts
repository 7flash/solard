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

    const input = pumpLaunchInputFromRecord(parsed.body);

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
