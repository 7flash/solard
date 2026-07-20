import type { TokenRow } from "../../db/schema.ts";
import type { SolardActionContext } from "./context.ts";

export async function addTokenAction(
  ctx: SolardActionContext,
  input: { mint: string; name?: string | null; metadataJson?: string | null },
): Promise<TokenRow> {
  const mint = input.mint?.trim();
  if (!mint) throw new Error("mint is required");
  return await ctx.slrd.addToken(
    mint,
    input.name?.trim() || undefined,
    input.metadataJson ? { metadataJson: input.metadataJson } : {},
  );
}

export async function refreshTokenAction(
  ctx: SolardActionContext,
  input: { token: string },
): Promise<TokenRow> {
  const token = input.token?.trim();
  if (!token) throw new Error("token is required");
  return await ctx.slrd.refreshToken(token);
}

export function configureTokenAction(
  ctx: SolardActionContext,
  input: {
    token: string;
    pool?: string | null;
    quoteMint?: string | null;
    quoteProgram?: string | null;
    metadataJson?: string | null;
  },
): TokenRow {
  const token = input.token?.trim();
  if (!token) throw new Error("token is required");
  const patch: Partial<TokenRow> = {};
  if (input.pool) patch.pool = input.pool;
  if (input.quoteMint) patch.quoteMint = input.quoteMint;
  if (input.quoteProgram) patch.quoteTokenProgram = input.quoteProgram;
  if (input.metadataJson) patch.metadataJson = input.metadataJson;
  return ctx.slrd.configureToken(token, patch);
}

export function listTokensAction(ctx: SolardActionContext): TokenRow[] {
  return ctx.slrd.tokens.list();
}
