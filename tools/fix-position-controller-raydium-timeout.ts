import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const target = resolve(process.argv[2] ?? "examples/position-controller.ts");
const source = readFileSync(target, "utf8");
const marker = "confirmationPending: true";

if (source.includes(marker)) {
  process.stdout.write(`${target}\nalready patched\n`);
  process.exit(0);
}

const startNeedle =
  "  const result = await args.raydium.executePrepared(prepared, {";
const start = source.indexOf(startNeedle);
if (start < 0) {
  throw new Error(
    "Could not find Raydium executePrepared block in target file",
  );
}

const returnNeedle =
  '  return {\n    venue: "raydium",\n    signature: result.signatures.at(-1) ?? null,\n    outputRaw: prepared.quote.outputRaw,\n    raw: result,\n  };';
const returnStart = source.indexOf(returnNeedle, start);
if (returnStart < 0) {
  throw new Error("Could not find Raydium result return block in target file");
}
const end = returnStart + returnNeedle.length;

const replacement = `  try {\n    const result = await args.raydium.executePrepared(prepared, {\n      live: true,\n      simulate: true,\n      commitment: "confirmed",\n    });\n    return {\n      venue: "raydium",\n      signature: result.signatures.at(-1) ?? null,\n      outputRaw: prepared.quote.outputRaw,\n      raw: result,\n    };\n  } catch (error) {\n    const err = error as { name?: unknown; message?: unknown; signature?: unknown };\n    const name = typeof err?.name === "string" ? err.name : "Error";\n    const message =\n      typeof err?.message === "string" ? err.message : String(error ?? "");\n    const signatureFromError =\n      typeof err?.signature === "string" && err.signature.length > 0\n        ? err.signature\n        : null;\n    const signatureFromMessage =\n      message.match(/Check signature ([1-9A-HJ-NP-Za-km-z]{80,100})/)?.[1] ??\n      null;\n    const signature = signatureFromError ?? signatureFromMessage;\n    const isConfirmationTimeout =\n      name === "TransactionExpiredTimeoutError" ||\n      message.includes("unknown if it succeeded or failed");\n    if (!isConfirmationTimeout || !signature) throw error;\n    return {\n      venue: "raydium",\n      signature,\n      outputRaw: prepared.quote.outputRaw,\n      raw: {\n        confirmationPending: true,\n        name,\n        message,\n      },\n    };\n  }`;

const backup = `${target}.before-raydium-timeout-fix`;
copyFileSync(target, backup);
const patched = source.slice(0, start) + replacement + source.slice(end);
writeFileSync(target, patched, "utf8");
process.stdout.write(`${target}\n${backup}\n`);
