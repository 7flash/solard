import type { SolardActionContext } from "./context.js";

export function createGroupAction(
  ctx: SolardActionContext,
  input: { name: string; description?: string | null },
) {
  const name = input.name?.trim();
  if (!name) throw new Error("group name is required");
  return ctx.sowl.groups.create(name, input.description?.trim() || undefined);
}

export function addWalletToGroupAction(
  ctx: SolardActionContext,
  input: { group: string; wallet: string; weightBps?: number | null },
) {
  const group = input.group?.trim();
  const wallet = input.wallet?.trim();
  if (!group) throw new Error("group is required");
  if (!wallet) throw new Error("wallet is required");
  ctx.sowl.groups.create(group);
  const resolved = ctx.sowl.resolveWallet(wallet);
  return ctx.sowl.groups.addWallet(
    group,
    resolved.address.toBase58(),
    input.weightBps ?? 10000,
  );
}

export function addManyWalletsToGroupAction(
  ctx: SolardActionContext,
  input: { group: string; wallets: string[] },
) {
  const group = input.group?.trim();
  if (!group) throw new Error("group is required");
  ctx.sowl.groups.create(group);
  const members = input.wallets
    .map((wallet) => wallet.trim())
    .filter(Boolean)
    .map((wallet) =>
      addWalletToGroupAction(ctx, { group, wallet, weightBps: 10000 }),
    );
  return { group, added: members.length, members };
}

export function showGroupAction(
  ctx: SolardActionContext,
  input: { group: string },
) {
  const group = input.group?.trim();
  if (!group) throw new Error("group is required");
  const members = ctx.sowl.groups.wallets(group).map((row) => {
    const wallet = ctx.sowl.resolveWallet(row.walletAddress);
    return {
      name: wallet.row?.name ?? null,
      address: wallet.address.toBase58(),
      weightBps: row.weightBps,
    };
  });
  return { group, members };
}

export function listGroupsAction(ctx: SolardActionContext) {
  return ctx.sowl.groups.list();
}
