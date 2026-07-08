import { PublicKey, type Commitment } from "@solana/web3.js";
import type { Sowl } from "../index.js";
import { measureSolard, summarizeForMeasure } from "./api-response.js";

const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEiNGyNxDbhNQrUVgktvRFw4A9h7";
const BASE58_PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export type TokenHolder = {
  tokenAccount: string;
  owner: string | null;
  amount: string | null;
  uiAmount: string | null;
  decimals: number | null;
};

export type TokenHoldersResult = {
  mint: string;
  ok: boolean;
  holders: TokenHolder[];
  unavailableReason?: string | null;
};

function short(value: string | null | undefined): string | null {
  return value
    ? value.length <= 14
      ? value
      : `${value.slice(0, 6)}…${value.slice(-6)}`
    : null;
}

function cleanError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 240 ? `${message.slice(0, 200)}…` : message;
}

function parsePublicKey(value: string): PublicKey | null {
  const trimmed = value.trim();
  if (!BASE58_PUBKEY_RE.test(trimmed)) return null;
  try {
    return new PublicKey(trimmed);
  } catch {
    return null;
  }
}

function empty(mint: string, unavailableReason: string): TokenHoldersResult {
  return { mint, ok: false, holders: [], unavailableReason };
}

function parseOwner(parsed: unknown): {
  owner: string | null;
  decimals: number | null;
} {
  const info =
    (parsed as any)?.value?.data?.parsed?.info ??
    (parsed as any)?.data?.parsed?.info;
  const tokenAmount = info?.tokenAmount;
  return {
    owner: typeof info?.owner === "string" ? info.owner : null,
    decimals:
      typeof tokenAmount?.decimals === "number" ? tokenAmount.decimals : null,
  };
}

function isParsedMintAccount(value: unknown): boolean {
  const account = (value as any)?.value ?? value;
  const owner =
    typeof account?.owner?.toBase58 === "function"
      ? account.owner.toBase58()
      : String(account?.owner ?? "");
  const parsedType = account?.data?.parsed?.type;
  return (
    (owner === TOKEN_PROGRAM_ID || owner === TOKEN_2022_PROGRAM_ID) &&
    parsedType === "mint"
  );
}

export async function loadTokenHolders(
  sowl: Sowl,
  args: { mint: string; limit?: number; commitment?: Commitment },
): Promise<TokenHoldersResult> {
  const mint = args.mint.trim();
  if (!mint) return empty(mint, "mint is required");
  const mintKey = parsePublicKey(mint);
  if (!mintKey) return empty(mint, "not a Solana public key");

  const limit = Math.max(1, Math.min(50, Number(args.limit ?? 12) || 12));
  const commitment = args.commitment ?? "confirmed";

  return (
    await measureSolard(
      "solard:token-holders",
      `load ${short(mint)}`,
      async () => {
        const connection = sowl.connection();

        let mintInfo: unknown;
        try {
          mintInfo = await connection.getParsedAccountInfo(mintKey, commitment);
        } catch (error) {
          return empty(
            mint,
            `mint account lookup failed: ${cleanError(error)}`,
          );
        }

        if (!(mintInfo as any)?.value)
          return empty(mint, "mint account not found");
        if (!isParsedMintAccount(mintInfo))
          return empty(mint, "not a Token/SPL mint");

        try {
          const largest = await connection.getTokenLargestAccounts(
            mintKey,
            commitment,
          );
          const accounts = largest.value.slice(0, limit);
          const holders = await Promise.all(
            accounts.map(async (account) => {
              let owner: string | null = null;
              let decimals: number | null = account.decimals ?? null;
              try {
                const parsed = await connection.getParsedAccountInfo(
                  account.address,
                  commitment,
                );
                const parsedOwner = parseOwner(parsed);
                owner = parsedOwner.owner;
                decimals = parsedOwner.decimals ?? decimals;
              } catch {
                // Largest account is still useful even if owner lookup misses.
              }
              return {
                tokenAccount: account.address.toBase58(),
                owner,
                amount: account.amount,
                uiAmount:
                  account.uiAmountString ??
                  (typeof account.uiAmount === "number"
                    ? String(account.uiAmount)
                    : null),
                decimals,
              };
            }),
          );
          return { mint, ok: true, holders, unavailableReason: null };
        } catch (error) {
          // This endpoint is used from hover inspection. A bad cached row must never
          // become a server-level exception or crash loop.
          return empty(mint, cleanError(error));
        }
      },
      summarizeForMeasure,
    )
  ).value;
}
