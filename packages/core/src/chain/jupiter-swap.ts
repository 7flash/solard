import { NATIVE_MINT } from "@solana/spl-token";
import { Keypair, VersionedTransaction } from "@solana/web3.js";

const BASE_URL = "https://api.jup.ag/swap/v2";

export type JupiterSwapOrder = {
  transaction: string | null;
  requestId?: string;
  inAmount?: string;
  outAmount?: string;
  router?: string;
  mode?: string;
  feeBps?: number;
  feeMint?: string;
  errorCode?: number;
  errorMessage?: string;
};

export type JupiterSwapQuote = {
  inputMint: string;
  outputMint: string;
  amountRaw: bigint;
  outAmountRaw: bigint;
  router: string | null;
  feeBps: number | null;
  feeMint: string | null;
};

export type JupiterSwapExecuteResult = {
  status: "Success" | "Failed";
  signature?: string;
  code: number;
  totalInputAmount?: string;
  totalOutputAmount?: string;
  inputAmountResult?: string;
  outputAmountResult?: string;
  error?: string;
};

const sleep = (ms: number) =>
  ms > 0
    ? new Promise<void>((resolve) => setTimeout(resolve, ms))
    : Promise.resolve();

function envNumber(name: string, fallback: number, minimum: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback;
}

let apiTail: Promise<void> = Promise.resolve();
let apiNextStartAtMs = 0;

async function acquireJupiterSlot(): Promise<void> {
  const hasApiKey = Boolean(process.env.JUPITER_API_KEY?.trim());
  // Jupiter currently documents 0.5 RPS for keyless access and 1 RPS for the
  // free API-key plan. Be conservative by default; paid users may override.
  const maxRps = envNumber("SLRD_JUPITER_MAX_RPS", hasApiKey ? 1 : 0.5, 0.1);
  const spacingMs = Math.ceil(1000 / maxRps) + 10;

  let release!: () => void;
  const previous = apiTail;
  apiTail = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    const waitMs = Math.max(0, apiNextStartAtMs - Date.now());
    if (waitMs > 0) await sleep(waitMs);
    apiNextStartAtMs = Date.now() + spacingMs;
  } finally {
    release();
  }
}

async function jupiterFetch(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const maxRetries = Math.trunc(envNumber("SLRD_JUPITER_429_RETRIES", 4, 0));
  let attempt = 0;

  while (true) {
    await acquireJupiterSlot();
    const headers = new Headers(init.headers);
    const key = process.env.JUPITER_API_KEY?.trim();
    if (key) headers.set("x-api-key", key);

    const response = await fetch(url, { ...init, headers });
    if (response.status !== 429 || attempt >= maxRetries) return response;

    const retryAfter = Number(response.headers.get("retry-after") ?? "");
    const delayMs =
      Number.isFinite(retryAfter) && retryAfter >= 0
        ? Math.max(500, Math.ceil(retryAfter * 1000))
        : Math.min(8_000, 500 * 2 ** attempt);
    attempt += 1;
    await sleep(delayMs);
  }
}

function orderUrl(args: {
  inputMint: string;
  amountRaw: bigint;
  taker?: string;
}): string {
  const query = new URLSearchParams({
    inputMint: args.inputMint,
    outputMint: NATIVE_MINT.toBase58(),
    amount: args.amountRaw.toString(),
  });
  if (args.taker) query.set("taker", args.taker);
  return `${BASE_URL}/order?${query}`;
}

async function readOrder(response: Response): Promise<JupiterSwapOrder> {
  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `Jupiter /order HTTP ${response.status}${body ? `: ${body.slice(0, 500)}` : ""}`,
    );
  }
  try {
    return JSON.parse(body) as JupiterSwapOrder;
  } catch (error) {
    throw new Error("Jupiter /order returned invalid JSON", { cause: error });
  }
}

export async function quoteJupiterTokenToSol(args: {
  inputMint: string;
  amountRaw: bigint;
}): Promise<JupiterSwapQuote> {
  if (args.amountRaw <= 0n)
    throw new Error("Jupiter quote amount must be positive");

  const order = await readOrder(await jupiterFetch(orderUrl(args)));
  const outAmount = String(order.outAmount ?? "0");
  const outAmountRaw = /^\\d+$/.test(outAmount) ? BigInt(outAmount) : 0n;

  if (order.errorCode != null || outAmountRaw <= 0n) {
    throw new Error(
      order.errorMessage ??
        `Jupiter has no executable route for ${args.inputMint}`,
    );
  }

  return {
    inputMint: args.inputMint,
    outputMint: NATIVE_MINT.toBase58(),
    amountRaw: args.amountRaw,
    outAmountRaw,
    router: order.router ?? null,
    feeBps: typeof order.feeBps === "number" ? order.feeBps : null,
    feeMint: order.feeMint ?? null,
  };
}

export async function executeJupiterTokenToSol(args: {
  inputMint: string;
  amountRaw: bigint;
  signer: Keypair;
}): Promise<JupiterSwapExecuteResult> {
  if (args.amountRaw <= 0n)
    throw new Error("Jupiter swap amount must be positive");

  const order = await readOrder(
    await jupiterFetch(
      orderUrl({
        inputMint: args.inputMint,
        amountRaw: args.amountRaw,
        taker: args.signer.publicKey.toBase58(),
      }),
    ),
  );

  if (!order.transaction || !order.requestId) {
    throw new Error(
      order.errorMessage ??
        `Jupiter could not build a transaction for ${args.inputMint}`,
    );
  }

  const transaction = VersionedTransaction.deserialize(
    Buffer.from(order.transaction, "base64"),
  );
  // VersionedTransaction.sign signs this wallet's required signature slot while
  // preserving other signer slots used by RFQ routes for /execute completion.
  transaction.sign([args.signer]);

  const response = await jupiterFetch(`${BASE_URL}/execute`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      signedTransaction: Buffer.from(transaction.serialize()).toString(
        "base64",
      ),
      requestId: order.requestId,
    }),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `Jupiter /execute HTTP ${response.status}${body ? `: ${body.slice(0, 500)}` : ""}`,
    );
  }

  let result: JupiterSwapExecuteResult;
  try {
    result = JSON.parse(body) as JupiterSwapExecuteResult;
  } catch (error) {
    throw new Error("Jupiter /execute returned invalid JSON", { cause: error });
  }

  if (result.status !== "Success" || result.code !== 0) {
    throw new Error(
      `Jupiter swap failed (code ${result.code}): ${result.error ?? "unknown error"}`,
    );
  }
  return result;
}
