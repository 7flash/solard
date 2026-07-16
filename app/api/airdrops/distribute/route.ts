import { PublicKey } from "@solana/web3.js";
import {
  assertWebAuth,
  errorResponse,
  jsonResponse,
  readJson,
  withSowl,
} from "../../../../src/web/http.js";
import {
  getAirdropJob,
  listAirdropJobs,
} from "../../../../src/solard/airdrops/job-store.js";
import { startAirdropJob } from "../../../../src/solard/airdrops/executor.js";
import type {
  AirdropPlan,
  AirdropRecipient,
} from "../../../../src/solard/airdrops/types.js";

type AirdropRequest = {
  name?: unknown;
  bankWallet?: unknown;
  sourceMint?: unknown;
  payoutMint?: unknown;
  payoutDecimals?: unknown;
  mode?: unknown;
  memo?: unknown;
  recipients?: unknown;
  totalAmountUi?: unknown;
  live?: unknown;
  confirmation?: unknown;
};

function requiredString(value: unknown, label: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    throw Object.assign(new Error(`${label} is required.`), { status: 400 });
  }
  return text;
}

function publicKeyString(value: unknown, label: string): string {
  const text = requiredString(value, label);
  try {
    return new PublicKey(text).toBase58();
  } catch {
    throw Object.assign(
      new Error(`${label} must be a valid Solana public key.`),
      { status: 400 },
    );
  }
}

function decimalString(value: unknown, label: string): string {
  const text = requiredString(value, label);
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text) || Number(text) <= 0) {
    throw Object.assign(
      new Error(`${label} must be a positive decimal amount.`),
      { status: 400 },
    );
  }
  return text;
}

function uiAmountToUnits(
  value: string,
  decimals: number,
  label: string,
): bigint {
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) {
    throw Object.assign(
      new Error(`${label} has more than ${decimals} decimal places.`),
      { status: 400 },
    );
  }
  return (
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt((fraction + "0".repeat(decimals)).slice(0, decimals) || "0")
  );
}

function planId(value: unknown): string {
  const text = JSON.stringify(value);
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * prime);
  }
  return `airdrop-${hash.toString(16).padStart(16, "0")}`;
}

function cleanRecipients(
  value: unknown,
  payoutDecimals: number,
): AirdropRecipient[] {
  if (!Array.isArray(value) || !value.length) {
    throw Object.assign(new Error("At least one recipient is required."), {
      status: 400,
    });
  }
  if (value.length > 5_000) {
    throw Object.assign(
      new Error("Airdrops are limited to 5,000 recipients per request."),
      { status: 400 },
    );
  }

  const seen = new Set<string>();
  return value.map((item, index) => {
    const row =
      item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const owner = publicKeyString(row.owner, `recipients[${index}].owner`);
    if (seen.has(owner)) {
      throw Object.assign(new Error(`Duplicate recipient: ${owner}`), {
        status: 400,
      });
    }
    seen.add(owner);
    const amountUi = decimalString(
      row.amountUi,
      `recipients[${index}].amountUi`,
    );
    return {
      owner,
      amountUi,
      amountRaw: uiAmountToUnits(
        amountUi,
        payoutDecimals,
        `recipients[${index}].amountUi`,
      ).toString(),
      sourceBalanceUi: Number.isFinite(Number(row.sourceBalanceUi))
        ? Number(row.sourceBalanceUi)
        : undefined,
      sourceSharePct: Number.isFinite(Number(row.sourceSharePct))
        ? Number(row.sourceSharePct)
        : undefined,
    };
  });
}

function normalize(body: AirdropRequest): AirdropPlan {
  const payoutDecimals = Math.floor(Number(body.payoutDecimals));
  if (
    !Number.isFinite(payoutDecimals) ||
    payoutDecimals < 0 ||
    payoutDecimals > 18
  ) {
    throw Object.assign(new Error("payoutDecimals must be between 0 and 18."), {
      status: 400,
    });
  }

  const mode = String(body.mode ?? "fixed") as AirdropPlan["mode"];
  if (!["fixed", "equal-total", "pro-rata"].includes(mode)) {
    throw Object.assign(new Error("Unknown distribution mode."), {
      status: 400,
    });
  }

  const bankWallet = publicKeyString(body.bankWallet, "bankWallet");
  const recipients = cleanRecipients(body.recipients, payoutDecimals);
  if (recipients.some((recipient) => recipient.owner === bankWallet)) {
    throw Object.assign(
      new Error("The bank wallet cannot also be an airdrop recipient."),
      { status: 400 },
    );
  }

  const totalAmountUi = decimalString(body.totalAmountUi, "totalAmountUi");
  const calculatedRaw = recipients.reduce(
    (sum, recipient) => sum + BigInt(recipient.amountRaw),
    0n,
  );
  const declaredRaw = uiAmountToUnits(
    totalAmountUi,
    payoutDecimals,
    "totalAmountUi",
  );
  if (declaredRaw !== calculatedRaw) {
    throw Object.assign(
      new Error("totalAmountUi does not equal the sum of recipient amounts."),
      { status: 400 },
    );
  }

  const core = {
    schema: "solard.airdrop-plan" as const,
    version: 2 as const,
    name: requiredString(body.name, "name").slice(0, 120),
    bankWallet,
    sourceMint: publicKeyString(body.sourceMint, "sourceMint"),
    payoutMint: publicKeyString(body.payoutMint, "payoutMint"),
    payoutDecimals,
    mode,
    memo:
      typeof body.memo === "string" && body.memo.trim()
        ? body.memo.trim().slice(0, 200)
        : null,
    recipients,
    recipientCount: recipients.length,
    totalAmountUi,
    totalAmountRaw: calculatedRaw.toString(),
  };

  return {
    ...core,
    planId: planId(core),
    requestedAt: new Date().toISOString(),
  };
}

export async function GET(request: Request): Promise<Response> {
  try {
    assertWebAuth(request);
    const url = new URL(request.url);
    const id = (url.searchParams.get("id") ?? "").trim();
    if (id) {
      const job = await getAirdropJob(id);
      if (!job) {
        return Response.json(
          { ok: false, error: "Airdrop job not found." },
          { status: 404 },
        );
      }
      return jsonResponse({ ok: true, value: job });
    }

    const limit = Math.max(
      1,
      Math.min(100, Number(url.searchParams.get("limit") ?? "20") || 20),
    );
    return jsonResponse({
      ok: true,
      value: await listAirdropJobs(limit),
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

export async function POST(request: Request): Promise<Response> {
  const body = (await readJson(request)) as AirdropRequest;
  return withSowl(request, async (sowl) => {
    const plan = normalize(body);

    if (body.live !== true) {
      return { status: "validated", plan };
    }

    if (body.confirmation !== "AIRDROP") {
      throw Object.assign(
        new Error('confirmation must equal "AIRDROP" for live execution.'),
        { status: 400 },
      );
    }

    const job = await startAirdropJob(plan, sowl);
    return {
      status: job.status,
      job,
    };
  });
}
