import { Keypair } from "@solana/web3.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { availableParallelism } from "node:os";
import {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} from "node:worker_threads";

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;

const WORKER_PROGRESS_INTERVAL = 50_000;

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
  workers?: number;
  signal?: AbortSignal;
};

type WorkerData = {
  suffix: string;
  budget: number;
  workerId: number;
};

type WorkerMessage =
  | {
      type: "progress";
      workerId: number;
      attempts: number;
      lastMint: string;
    }
  | {
      type: "match";
      workerId: number;
      attempts: number;
      address: string;
      secretKey: number[];
    }
  | {
      type: "exhausted";
      workerId: number;
      attempts: number;
    };

const pregeneratedMint = new AsyncLocalStorage<Keypair>();

export function cleanVanitySuffix(value: string): string {
  const suffix = String(value || "").trim();

  if (!suffix) {
    throw new Error("Mint vanity suffix is empty");
  }

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

function secretKeyBytes(value: unknown): Uint8Array {
  const source = Array.isArray(value)
    ? value
    : value &&
        typeof value === "object" &&
        Array.isArray(
          (
            value as {
              secretKey?: unknown;
            }
          ).secretKey,
        )
      ? (
          value as {
            secretKey: unknown[];
          }
        ).secretKey
      : null;

  if (!source || source.length !== 64) {
    throw new Error(
      "Mint keypair JSON must contain exactly 64 secret-key bytes.",
    );
  }

  return Uint8Array.from(
    source.map((item, index) => {
      const byte = Number(item);

      if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
        throw new Error(`Mint keypair byte ${index} is invalid.`);
      }

      return byte;
    }),
  );
}

export function loadMintKeypairFile(path: string): {
  path: string;
  mint: Keypair;
  address: string;
} {
  const absolute = resolve(path);

  if (!existsSync(absolute)) {
    throw new Error(`Mint keypair file not found: ${absolute}`);
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(readFileSync(absolute, "utf8"));
  } catch (error) {
    throw new Error(`Could not parse mint keypair JSON at ${absolute}.`, {
      cause: error,
    });
  }

  const mint = Keypair.fromSecretKey(secretKeyBytes(parsed));

  return {
    path: absolute,

    mint,

    address: mint.publicKey.toBase58(),
  };
}

export function saveMintKeypairFile(
  path: string,
  mint: Keypair,
  options: {
    force?: boolean;
  } = {},
): string {
  const absolute = resolve(path);

  mkdirSync(dirname(absolute), {
    recursive: true,
  });

  writeFileSync(absolute, `${JSON.stringify(Array.from(mint.secretKey))}\n`, {
    encoding: "utf8",

    mode: 0o600,

    flag: options.force ? "w" : "wx",
  });

  return absolute;
}

export async function withPregeneratedMintKeypair<T>(
  mint: Keypair,
  run: () => Promise<T>,
): Promise<T> {
  return await pregeneratedMint.run(mint, run);
}

function pregeneratedResult(suffix: string, mint: Keypair): VanityMintResult {
  const address = mint.publicKey.toBase58();

  if (!address.endsWith(suffix)) {
    throw new Error(
      `Pregenerated mint ${address} does not end with required suffix ${suffix}.`,
    );
  }

  return {
    mint,
    suffix,
    attempts: 0,
    elapsedMs: 0,
    ratePerSecond: 0,
    lastMint: address,
  };
}

export async function generateMintKeypairWithSuffix(
  options: VanityMintOptions,
): Promise<VanityMintResult> {
  const suffix = cleanVanitySuffix(options.suffix);

  const override = pregeneratedMint.getStore();

  if (override) {
    return pregeneratedResult(suffix, override);
  }

  const maxAttempts = Math.max(
    1,
    Math.trunc(Number(options.maxAttempts ?? 25_000_000)),
  );

  const timeoutMs = Math.max(0, Math.trunc(Number(options.timeoutMs ?? 0)));

  const reportEvery = Math.max(
    1,
    Math.trunc(Number(options.reportEvery ?? 1_000_000)),
  );

  const requestedWorkers = Math.max(
    1,
    Math.trunc(Number(options.workers ?? availableParallelism())),
  );

  const workerCount = Math.min(requestedWorkers, maxAttempts);

  const baseBudget = Math.floor(maxAttempts / workerCount);

  const extraBudgets = maxAttempts % workerCount;

  const startedAt = Date.now();

  return await new Promise<VanityMintResult>(
    (resolvePromise, rejectPromise) => {
      const workers: Worker[] = [];

      const perWorkerAttempts = new Array<number>(workerCount).fill(0);

      let lastMint = "";

      let exhaustedCount = 0;

      let lastEmittedAt = 0;

      let settled = false;

      let timer: ReturnType<typeof setTimeout> | undefined;

      const signal = options.signal;

      const totalAttempts = () =>
        perWorkerAttempts.reduce((total, attempts) => total + attempts, 0);

      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
        }

        if (signal) {
          signal.removeEventListener("abort", onAbort);
        }

        for (const worker of workers) {
          void worker.terminate();
        }
      };

      const finish = (run: () => void) => {
        if (settled) {
          return;
        }

        settled = true;

        cleanup();
        run();
      };

      const onAbort = () =>
        finish(() =>
          rejectPromise(
            new Error(
              `Vanity grind for ${suffix} aborted after ${totalAttempts()} attempts.`,
            ),
          ),
        );

      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }

        signal.addEventListener("abort", onAbort, {
          once: true,
        });
      }

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          const attempts = totalAttempts();

          const elapsedMs = Math.max(1, Date.now() - startedAt);

          finish(() =>
            rejectPromise(
              new Error(
                `Timed out generating mint ending with ${suffix} after ${attempts} attempts in ${elapsedMs}ms. Increase timeoutMs or disable the suffix requirement.`,
              ),
            ),
          );
        }, timeoutMs);

        timer.unref?.();
      }

      for (let workerId = 0; workerId < workerCount; workerId++) {
        const budget = baseBudget + (workerId < extraBudgets ? 1 : 0);

        const data: WorkerData = {
          suffix,
          budget,
          workerId,
        };

        const worker = new Worker(new URL(import.meta.url), {
          workerData: data,
        });

        workers.push(worker);

        worker.on("message", (message: WorkerMessage) => {
          if (settled) {
            return;
          }

          perWorkerAttempts[message.workerId] = message.attempts;

          if (message.type === "progress") {
            lastMint = message.lastMint;

            const total = totalAttempts();

            if (total - lastEmittedAt >= reportEvery) {
              lastEmittedAt = total;

              const elapsedMs = Math.max(1, Date.now() - startedAt);

              options.onProgress?.({
                suffix,
                attempts: total,
                elapsedMs,
                ratePerSecond: Math.round((total * 1_000) / elapsedMs),
                lastMint,
              });
            }

            return;
          }

          if (message.type === "match") {
            const total = totalAttempts();

            const elapsedMs = Math.max(1, Date.now() - startedAt);

            const mint = Keypair.fromSecretKey(
              new Uint8Array(message.secretKey),
            );

            finish(() =>
              resolvePromise({
                mint,
                suffix,
                attempts: total,
                elapsedMs,
                ratePerSecond: Math.round((total * 1_000) / elapsedMs),
                lastMint: message.address,
              }),
            );

            return;
          }

          exhaustedCount++;

          if (exhaustedCount >= workerCount) {
            const total = totalAttempts();

            const elapsedMs = Math.max(1, Date.now() - startedAt);

            finish(() =>
              rejectPromise(
                new Error(
                  `Could not generate mint ending with ${suffix} after ${total} attempts in ${elapsedMs}ms across ${workerCount} workers. Increase maxAttempts or use a shorter suffix.`,
                ),
              ),
            );
          }
        });

        worker.on("error", (error) => finish(() => rejectPromise(error)));

        worker.on("exit", (code) => {
          if (!settled && code !== 0) {
            finish(() =>
              rejectPromise(
                new Error(
                  `Vanity worker ${workerId} exited with code ${code}.`,
                ),
              ),
            );
          }
        });
      }
    },
  );
}

if (!isMainThread && parentPort) {
  const port = parentPort;

  const { suffix, budget, workerId } = workerData as WorkerData;

  let lastMint = "";

  let attempts = 0;

  let matched = false;

  for (attempts = 1; attempts <= budget; attempts++) {
    const mint = Keypair.generate();

    const address = mint.publicKey.toBase58();

    lastMint = address;

    if (address.endsWith(suffix)) {
      port.postMessage({
        type: "match",

        workerId,
        attempts,
        address,

        secretKey: Array.from(mint.secretKey),
      } satisfies WorkerMessage);

      matched = true;

      break;
    }

    if (attempts % WORKER_PROGRESS_INTERVAL === 0) {
      port.postMessage({
        type: "progress",

        workerId,
        attempts,
        lastMint,
      } satisfies WorkerMessage);
    }
  }

  if (!matched) {
    port.postMessage({
      type: "exhausted",

      workerId,

      attempts: attempts - 1,
    } satisfies WorkerMessage);
  }
}
