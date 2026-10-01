import { configure, createMeasure } from "measure-fn";
import { createSolard, type ReplayItem } from "@solard/sdk";

configure({ silent: true });
const m = createMeasure("slrd:fairfun-history-bootstrap", {
  maxResultLength: 1600,
});

type Flags = Map<string, string>;

function parse(argv: string[]): Flags {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (!value.startsWith("--")) continue;
    const [key, inline] = value.slice(2).split("=", 2);
    if (inline != null) flags.set(key!, inline);
    else if (argv[index + 1] && !argv[index + 1]!.startsWith("--"))
      flags.set(key!, argv[++index]!);
    else flags.set(key!, "true");
  }
  return flags;
}

function required(flags: Flags, key: string): string {
  const value = flags.get(key);
  if (!value || value === "true") throw new Error(`Missing --${key} <value>`);
  return value;
}

function applyReplayBalance(
  balances: Map<string, bigint>,
  item: ReplayItem,
): void {
  for (const [owner, amount] of item.postBalance) {
    if (amount === 0n) balances.delete(owner);
    else balances.set(owner, amount);
  }
}

function holderState(balances: Map<string, bigint>) {
  return [...balances]
    .filter(([, amount]) => amount > 0n)
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([wallet, amountRaw]) => ({
      wallet,
      amountRaw: amountRaw.toString(),
    }));
}

function checkpoint(item: ReplayItem, balances: Map<string, bigint>) {
  const event = item.raw;
  if (event.type !== "claim") {
    throw new Error("Replay checkpoint requires a claim event");
  }
  return {
    id: event.id,
    signature: item.signature,
    slot: item.slot,
    transactionIndex: item.transactionIndex,
    amountRaw: event.payout.amountRaw.toString(),
    assetMint: event.payout.assetMint,
    recipient: event.payout.recipient,
    attribution: event.attribution,
    holdersAtClaim: holderState(balances),
  };
}

export async function runFairfunHistoryBootstrap(
  argv = process.argv.slice(2),
): Promise<void> {
  const flags = parse(argv);
  const token = required(flags, "token");
  const recipient = required(flags, "wallet");
  const provider = (flags.get("provider") ?? "auto") as
    "auto" | "solscan" | "rpc";
  const slrd = createSolard();
  try {
    const history = await m("history", () =>
      slrd.history.replay(token, {
        recipient,
        provider,
      }),
    );
    if (!history.coverage.complete) {
      throw new Error(
        `Historical Fairfun replay is incomplete: ${history.coverage.warnings.join(" ") || "coverage incomplete"}`,
      );
    }
    const balances = new Map<string, bigint>();
    const claims: ReturnType<typeof checkpoint>[] = [];
    for (const item of history) {
      applyReplayBalance(balances, item);
      if (item.trx === "claim") claims.push(checkpoint(item, balances));
    }
    process.stdout.write(
      `${JSON.stringify(
        {
          mint: history.mint,
          throughSlot: history.coverage.throughSlot,
          coverage: history.coverage,
          claims,
          currentHolders: holderState(balances),
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    slrd.close();
  }
}

if (import.meta.main) {
  runFairfunHistoryBootstrap().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
