import type { Solard } from "@solard/sdk";
import type { TradeCommandFlags } from "./trade-venue.ts";

export type TradeTargets = {
  mode: "wallet" | "wallets" | "group";
  refs: string[];
  group?: string;
};

function csv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function resolveTradeTargets(
  slrd: Pick<Solard, "groupWallets">,
  flags: TradeCommandFlags,
  usage: string,
): TradeTargets {
  const wallet = flags.get("wallet");
  const wallets = csv(flags.get("wallets"));
  const group = flags.get("group");
  const selected = [Boolean(wallet), wallets.length > 0, Boolean(group)].filter(
    Boolean,
  ).length;

  if (selected !== 1) {
    throw new Error(
      `${usage} Supply exactly one of --wallet, --wallets, or --group.`,
    );
  }

  if (wallet) return { mode: "wallet", refs: [wallet] };
  if (wallets.length > 0) return { mode: "wallets", refs: wallets };

  return {
    mode: "group",
    refs: slrd.groupWallets(group!).map((ref) => String(ref)),
    group,
  };
}
