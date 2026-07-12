import { availableParallelism } from "node:os";

import { cliMeasure, summarizeError } from "../../solard/measure.js";
import {
  cleanVanitySuffix,
  generateMintKeypairWithSuffix,
  saveMintKeypairFile,
} from "./vanity-mint.js";

type ParsedArgs = {
  suffix: string;
  out: string;
  workers: number;
  maxAttempts: number;
  timeoutMs: number;
  reportEvery: number;
  force: boolean;
};

function value(argv: readonly string[], name: string): string | null {
  const prefix = `--${name}=`;

  const inline = argv.find((entry) => entry.startsWith(prefix));

  if (inline) {
    return inline.slice(prefix.length);
  }

  const index = argv.indexOf(`--${name}`);

  return index >= 0 ? (argv[index + 1] ?? null) : null;
}

function required(argv: readonly string[], name: string): string {
  const found = value(argv, name)?.trim();

  if (!found) {
    throw new Error(`Missing --${name}.`);
  }

  return found;
}

function integer(
  argv: readonly string[],
  name: string,
  fallback: number,
  minimum: number,
): number {
  const raw = value(argv, name);

  const parsed = raw == null ? fallback : Number(raw);

  if (!Number.isFinite(parsed)) {
    throw new Error(`--${name} must be a number.`);
  }

  return Math.max(minimum, Math.trunc(parsed));
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  return {
    suffix: cleanVanitySuffix(required(argv, "suffix")),

    out: required(argv, "out"),

    workers: integer(argv, "workers", availableParallelism(), 1),

    maxAttempts: integer(argv, "max-attempts", 25_000_000, 1),

    timeoutMs: integer(argv, "timeout-ms", 0, 0),

    reportEvery: integer(argv, "report-every", 1_000_000, 1),

    force: argv.includes("--force"),
  };
}

function progressAction(progress: {
  suffix: string;
  attempts: number;
  elapsedMs: number;
  ratePerSecond: number;
  lastMint: string;
}): void {
  cliMeasure.sync(
    {
      start: () => `vanity.mint.progress suffix=${progress.suffix}`,

      end: () => ({
        attempts: progress.attempts,

        elapsedMs: progress.elapsedMs,

        ratePerSecond: progress.ratePerSecond,

        lastMint: progress.lastMint,
      }),

      catch: summarizeError,
    },
    () => progress,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let originalError: unknown = null;

  const result = await cliMeasure.measure(
    {
      start: () =>
        `vanity.mint.generate suffix=${args.suffix} workers=${args.workers} maxAttempts=${args.maxAttempts}`,

      end: (found) => ({
        address: found.mint.publicKey.toBase58(),

        attempts: found.attempts,

        elapsedMs: found.elapsedMs,

        ratePerSecond: found.ratePerSecond,
      }),

      catch: summarizeError,
    },
    async () => {
      try {
        return await generateMintKeypairWithSuffix({
          suffix: args.suffix,

          workers: args.workers,

          maxAttempts: args.maxAttempts,

          timeoutMs: args.timeoutMs,

          reportEvery: args.reportEvery,

          onProgress: progressAction,
        });
      } catch (error) {
        originalError = error;

        throw error;
      }
    },
  );

  if (originalError) {
    throw originalError;
  }

  const address = result.mint.publicKey.toBase58();

  let writeError: unknown = null;

  const outputPath = cliMeasure.sync(
    {
      start: () =>
        `vanity.mint.write address=${address.slice(0, 6)}…${address.slice(-4)}`,

      end: (path) => ({
        path,
        address,
        suffix: args.suffix,
      }),

      catch: summarizeError,
    },
    () => {
      try {
        return saveMintKeypairFile(args.out, result.mint, {
          force: args.force,
        });
      } catch (error) {
        writeError = error;

        throw error;
      }
    },
  );

  if (writeError) {
    throw writeError;
  }

  cliMeasure.sync(
    {
      start: () => "vanity.mint.ready",

      end: () => ({
        address,
        keypairPath: outputPath,

        launchArguments: [
          "--mint-keypair",
          outputPath,
          "--mint-address",
          address,
          "--mint-suffix",
          args.suffix,
        ],
      }),

      catch: summarizeError,
    },
    () => ({
      address,
      keypairPath: outputPath,
    }),
  );
}

await main().catch(() => {
  process.exitCode = 1;
});
