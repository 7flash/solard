import {
  cliMeasure,
  summarizeError,
  summarizeForMeasure,
} from "../../solard/measure.ts";
import {
  runPumpTokenLaunchFromArgs,
  type PumpTokenLaunchCliResult,
} from "./token-launch-cli.ts";
import {
  loadMintKeypairFile,
  withPregeneratedMintKeypair,
} from "./vanity-mint.ts";

function argumentValue(argv: readonly string[], name: string): string | null {
  const prefix = `--${name}=`;

  const inline = argv.find((value) => value.startsWith(prefix));

  if (inline) {
    return inline.slice(prefix.length);
  }

  const index = argv.indexOf(`--${name}`);

  if (index < 0 || index + 1 >= argv.length) {
    return null;
  }

  const value = argv[index + 1];

  return value?.startsWith("--") ? null : (value ?? null);
}

function withoutValueFlags(
  argv: readonly string[],
  names: readonly string[],
): string[] {
  const output: string[] = [];

  for (let index = 0; index < argv.length; index++) {
    const current = argv[index] ?? "";

    if (names.some((name) => current.startsWith(`--${name}=`))) {
      continue;
    }

    const matched = names.find((name) => current === `--${name}`);

    if (matched) {
      index++;
      continue;
    }

    output.push(current);
  }

  return output;
}

function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

function compactId(
  value: string | null | undefined,
  head = 6,
  tail = 4,
): string {
  const text = String(value ?? "");

  if (!text || text.length <= head + tail + 1) {
    return text || "none";
  }

  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

function buyerCount(argv: readonly string[]): number {
  const raw = argumentValue(argv, "buy-plan-json");

  if (!raw) {
    return argumentValue(argv, "buyer-group") ? 1 : 0;
  }

  try {
    const parsed = JSON.parse(raw);

    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

function eventName(label: string): string {
  const clean = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 80);

  return clean || "progress";
}

function reportMeasured(label: string, value: unknown): void {
  cliMeasure.sync(
    {
      start: () => `launch.pump.${eventName(label)}`,

      end: () => summarizeForMeasure(value),

      catch: summarizeError,
    },
    () => value,
  );
}

function resultSummary(result: PumpTokenLaunchCliResult): unknown {
  const row = result as unknown as Record<string, any>;

  return {
    mint: compactId(row.token?.mint ?? row.mint),

    signature: compactId(row.deployment?.signature ?? row.signature),

    result: summarizeForMeasure(result),
  };
}

async function main(): Promise<PumpTokenLaunchCliResult> {
  const argv = process.argv.slice(2);

  const creator = argumentValue(argv, "creator");

  const symbol = argumentValue(argv, "symbol");

  const live = hasFlag(argv, "live");

  const mintKeypairPath = argumentValue(argv, "mint-keypair")?.trim() ?? "";

  const expectedMintAddress = argumentValue(argv, "mint-address")?.trim() ?? "";

  const mintSuffix = argumentValue(argv, "mint-suffix")?.trim() ?? "";

  if (expectedMintAddress && !mintKeypairPath) {
    throw new Error(
      "--mint-address cannot be used alone. Provide --mint-keypair so the mint can sign creation.",
    );
  }

  const pregenerated = mintKeypairPath
    ? loadMintKeypairFile(mintKeypairPath)
    : null;

  if (pregenerated && !mintSuffix) {
    throw new Error(
      "--mint-keypair requires --mint-suffix so the loaded address can be validated.",
    );
  }

  if (
    pregenerated &&
    expectedMintAddress &&
    pregenerated.address !== expectedMintAddress
  ) {
    throw new Error(
      `Mint keypair derives ${pregenerated.address}, not expected address ${expectedMintAddress}.`,
    );
  }

  if (pregenerated && !pregenerated.address.endsWith(mintSuffix)) {
    throw new Error(
      `Mint keypair address ${pregenerated.address} does not end with ${mintSuffix}.`,
    );
  }

  const launchArgv = withoutValueFlags(argv, ["mint-keypair", "mint-address"]);

  if (pregenerated) {
    reportMeasured("pregenerated mint loaded", {
      address: pregenerated.address,

      keypairPath: pregenerated.path,

      suffix: mintSuffix,
    });
  }

  let operationError: unknown = null;

  const measured = await cliMeasure.measure(
    {
      start: () =>
        `launch.pump.run creator=${compactId(creator)} symbol=${symbol ?? "none"} buyers=${buyerCount(argv)} live=${live} mint=${compactId(pregenerated?.address)}`,

      end: (result: PumpTokenLaunchCliResult) => resultSummary(result),

      catch: summarizeError,
    },
    async () => {
      try {
        const run = () =>
          runPumpTokenLaunchFromArgs(launchArgv, {
            defaultSubmitMode: "after-deploy-processed",

            defaultDeploymentPriorityMicroLamports: 0,

            defaultBuyerPriorityMicroLamports: 1_500_000,

            defaultSlippageBps: 9_999,

            persistOnLive: true,

            report: reportMeasured,
          });

        return pregenerated
          ? await withPregeneratedMintKeypair(pregenerated.mint, run)
          : await run();
      } catch (error) {
        operationError = error;

        throw error;
      }
    },
  );

  if (operationError) {
    throw operationError;
  }

  return measured;
}

await main().catch(() => {
  process.exitCode = 1;
});
