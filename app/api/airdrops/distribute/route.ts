import { PublicKey } from "@solana/web3.js";
import {
  assertWebAuth,
  errorResponse,
  jsonResponse,
  readJson,
} from "../../../../src/web/http.js";

type Recipient = {
  owner: string;
  amountUi: string;
  sourceBalanceUi?: number;
  sourceSharePct?: number;
};

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
  if (!text)
    throw Object.assign(new Error(`${label} is required.`), { status: 400 });
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

function cleanRecipients(value: unknown): Recipient[] {
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
    return {
      owner,
      amountUi: decimalString(row.amountUi, `recipients[${index}].amountUi`),
      sourceBalanceUi: Number.isFinite(Number(row.sourceBalanceUi))
        ? Number(row.sourceBalanceUi)
        : undefined,
      sourceSharePct: Number.isFinite(Number(row.sourceSharePct))
        ? Number(row.sourceSharePct)
        : undefined,
    };
  });
}

function normalize(body: AirdropRequest) {
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

  const mode = String(body.mode ?? "fixed");
  if (!["fixed", "equal-total", "pro-rata"].includes(mode)) {
    throw Object.assign(new Error("Unknown distribution mode."), {
      status: 400,
    });
  }

  const bankWallet = publicKeyString(body.bankWallet, "bankWallet");
  const recipients = cleanRecipients(body.recipients);
  if (recipients.some((recipient) => recipient.owner === bankWallet)) {
    throw Object.assign(
      new Error("The bank wallet cannot also be an airdrop recipient."),
      { status: 400 },
    );
  }

  const totalAmountUi = decimalString(body.totalAmountUi, "totalAmountUi");
  const calculatedRaw = recipients.reduce(
    (sum, recipient, index) =>
      sum +
      uiAmountToUnits(
        recipient.amountUi,
        payoutDecimals,
        `recipients[${index}].amountUi`,
      ),
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
    schema: "solard.airdrop-plan",
    version: 1,
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
    live: body.live === true,
  };

  return {
    ...core,
    planId: planId(core),
    requestedAt: new Date().toISOString(),
  };
}

async function executeWithConfiguredService(
  plan: ReturnType<typeof normalize>,
) {
  const executorUrl = process.env.SOLARD_AIRDROP_EXECUTOR_URL?.trim();
  if (!executorUrl) {
    throw Object.assign(
      new Error(
        "Live airdrop executor is not configured. Set SOLARD_AIRDROP_EXECUTOR_URL to the server-side wallet signing service.",
      ),
      { status: 501 },
    );
  }

  const token = process.env.SOLARD_AIRDROP_EXECUTOR_TOKEN?.trim();
  const response = await fetch(executorUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": plan.planId,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(plan),
    signal: AbortSignal.timeout(120_000),
  });

  const text = await response.text();
  let value: unknown = text;
  try {
    value = text ? JSON.parse(text) : null;
  } catch {
    // Preserve non-JSON executor responses for diagnostics.
  }

  if (!response.ok) {
    const message =
      value && typeof value === "object" && "error" in value
        ? String((value as { error: unknown }).error)
        : `Airdrop executor returned HTTP ${response.status}.`;
    throw Object.assign(new Error(message), { status: 502 });
  }

  return value;
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertWebAuth(request);
    const body = (await readJson(request)) as AirdropRequest;
    const plan = normalize(body);

    if (!plan.live) {
      return jsonResponse({
        ok: true,
        value: {
          status: "validated",
          plan,
        },
      });
    }

    if (body.confirmation !== "AIRDROP") {
      throw Object.assign(
        new Error('confirmation must equal "AIRDROP" for live execution.'),
        {
          status: 400,
        },
      );
    }

    const result = await executeWithConfiguredService(plan);
    return jsonResponse({
      ok: true,
      value: {
        status: "submitted",
        plan,
        result,
      },
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
