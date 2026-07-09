import { Keypair } from "@solana/web3.js";

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;

export type VanityMintProgress = {
  suffix: string;
  attempts: number;
  elapsedMs: number;
  ratePerSecond: number;
  lastMint: string;
};

export type VanityMintResult = VanityMintProgress & {
  mint: Keypair;
};

export type VanityMintOptions = {
  suffix: string;
  maxAttempts?: number;
  timeoutMs?: number;
  reportEvery?: number;
  onProgress?: (progress: VanityMintProgress) => void;
};

function cleanSuffix(value: string): string {
  const suffix = String(value || "").trim();
  if (!suffix) throw new Error("Mint vanity suffix is empty");
  if (suffix.length > 8) {
    throw new Error(
      `Mint vanity suffix ${JSON.stringify(suffix)} is too long. Use a short suffix such as pump.`,
    );
  }
  if (!BASE58_RE.test(suffix)) {
    throw new Error(
      `Mint vanity suffix ${JSON.stringify(suffix)} is not valid base58.`,
    );
  }
  return suffix;
}

function nowMs(): number {
  return Date.now();
}

export async function generateMintKeypairWithSuffix(
  options: VanityMintOptions,
): Promise<VanityMintResult> {
  const suffix = cleanSuffix(options.suffix);
  const maxAttempts = Math.max(
    1,
    Math.trunc(Number(options.maxAttempts ?? 25_000_000)),
  );
  const timeoutMs = Math.max(0, Math.trunc(Number(options.timeoutMs ?? 0)));
  const reportEvery = Math.max(
    1,
    Math.trunc(Number(options.reportEvery ?? 1_000_000)),
  );
  const startedAt = nowMs();
  let lastMint = "";

  for (let attempts = 1; attempts <= maxAttempts; attempts++) {
    const mint = Keypair.generate();
    const address = mint.publicKey.toBase58();
    lastMint = address;
    if (address.endsWith(suffix)) {
      const elapsedMs = Math.max(1, nowMs() - startedAt);
      return {
        mint,
        suffix,
        attempts,
        elapsedMs,
        ratePerSecond: Math.round((attempts * 1000) / elapsedMs),
        lastMint: address,
      };
    }

    if (attempts % reportEvery === 0) {
      const elapsedMs = Math.max(1, nowMs() - startedAt);
      options.onProgress?.({
        suffix,
        attempts,
        elapsedMs,
        ratePerSecond: Math.round((attempts * 1000) / elapsedMs),
        lastMint,
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    if (timeoutMs > 0 && nowMs() - startedAt >= timeoutMs) {
      const elapsedMs = Math.max(1, nowMs() - startedAt);
      throw new Error(
        `Timed out generating mint ending with ${suffix} after ${attempts} attempts in ${elapsedMs}ms. Increase --vanity-timeout-ms or disable the suffix requirement.`,
      );
    }
  }

  const elapsedMs = Math.max(1, nowMs() - startedAt);
  throw new Error(
    `Could not generate mint ending with ${suffix} after ${maxAttempts} attempts in ${elapsedMs}ms. Increase --vanity-max-attempts or use a shorter suffix.`,
  );
}
