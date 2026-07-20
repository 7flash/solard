import type { SolardActionContext } from "./context.ts";

export type WatchKind = "token" | "wallet" | "program";

export function watchAction(
  ctx: SolardActionContext,
  input: { kind: WatchKind; ref: string; label?: string | null },
) {
  const ref = input.ref?.trim();
  if (!ref) throw new Error(`${input.kind} ref is required`);
  if (input.kind === "token")
    return ctx.slrd.watchToken(ref, input.label?.trim() || undefined);
  if (input.kind === "wallet")
    return ctx.slrd.watchWallet(ref, input.label?.trim() || undefined);
  return ctx.slrd.watchProgram(ref, input.label?.trim() || undefined);
}

export function listWatchesAction(ctx: SolardActionContext) {
  return ctx.slrd.db.watches.select().where({ isActive: 1 }).all();
}
