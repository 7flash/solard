import type { SolardActionContext } from "./context.js";

export type WatchKind = "token" | "wallet" | "program";

export function watchAction(
  ctx: SolardActionContext,
  input: { kind: WatchKind; ref: string; label?: string | null },
) {
  const ref = input.ref?.trim();
  if (!ref) throw new Error(`${input.kind} ref is required`);
  if (input.kind === "token")
    return ctx.sowl.watchToken(ref, input.label?.trim() || undefined);
  if (input.kind === "wallet")
    return ctx.sowl.watchWallet(ref, input.label?.trim() || undefined);
  return ctx.sowl.watchProgram(ref, input.label?.trim() || undefined);
}

export function listWatchesAction(ctx: SolardActionContext) {
  return ctx.sowl.db.watches.select().where({ isActive: 1 }).all();
}
