import type { Connection, PublicKey } from "@solana/web3.js";
import type { TokenRow } from "../db/schema.ts";
import type { ClaimPlan, ClaimSourcePlugin } from "./claim-source.ts";

export type CreatorFeeItem = {
  mint: string;
  source: string | null;
  status: "claimable" | "empty" | "unsupported" | "error";
  message?: string;
  groupKeys: Array<string>;
};
export type CreatorFeeGroup = {
  key: string;
  source: string;
  quoteMint: string;
  quoteDecimals: number;
  amountRaw: bigint;
  spendableRaw: bigint;
  relatedMints: Array<string>;
  /** Creator vaults can receive revenue from several coins; amounts are vault totals. */
  attribution: "shared-creator-vault" | "mint-sharing-vault" | "source-defined";
};
export type CreatorFeeDiscovery = {
  wallet: string;
  items: Array<CreatorFeeItem>;
  groups: Array<CreatorFeeGroup>;
  plans: Array<ClaimPlan>;
};

/** Read-only claim discovery. No signer or submission callback is accepted. */
export async function getClaimableCreatorFees(
  connection: Connection,
  wallet: PublicKey,
  tokens: ReadonlyArray<TokenRow>,
  sources: ReadonlyArray<ClaimSourcePlugin>,
): Promise<CreatorFeeDiscovery> {
  const items: Array<CreatorFeeItem> = [];
  const groups = new Map<string, CreatorFeeGroup>();
  const plans: Array<ClaimPlan> = [];
  const instructionKeys = new Set<string>();
  for (const token of tokens) {
    try {
      const resolved: Array<ClaimPlan> = [];
      for (const source of sources) {
        try {
          const plan = await source.resolveClaim({
            connection,
            token,
            user: wallet,
          });
          if (plan) resolved.push(plan);
        } catch (error) {
          items.push({
            mint: token.mint,
            source: source.id,
            status: "error",
            groupKeys: [],
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (!resolved.length) {
        items.push({
          mint: token.mint,
          source: null,
          status: "unsupported",
          groupKeys: [],
          message:
            "No registered creator-fee source resolved an eligible claim",
        });
        continue;
      }
      for (const plan of resolved) {
        const components = Array.isArray(plan.meta?.claimComponents)
          ? (plan.meta.claimComponents as Array<{
              key: string;
              amountRaw: string;
              spendableRaw: string;
              quoteMint?: string;
              quoteDecimals?: number;
            }>)
          : [
              {
                key: `${plan.source}:${token.mint}:${plan.quoteAsset.mint.toBase58()}`,
                amountRaw: plan.estimatedClaimRaw.toString(),
                spendableRaw: plan.spendableByUserRaw.toString(),
              },
            ];
        const keys: Array<string> = [];
        let hasValue = false;
        let uniqueEstimate = 0n,
          uniqueSpendable = 0n;
        const uniqueComponents: typeof components = [];
        for (const component of components) {
          if (typeof component.key !== "string" || !component.key)
            throw new Error("Invalid creator-fee component identity");
          const amount = BigInt(component.amountRaw),
            spendable = BigInt(component.spendableRaw);
          hasValue ||= amount > 0n;
          if (amount < 0n || spendable < 0n || spendable > amount)
            throw new Error("Invalid creator-fee component amount");
          keys.push(component.key);
          const previous = groups.get(component.key);
          if (previous) {
            if (
              previous.quoteMint !==
                (component.quoteMint ?? plan.quoteAsset.mint.toBase58()) ||
              previous.source !== plan.source
            )
              throw new Error("Creator-fee group identity mismatch");
            if (!previous.relatedMints.includes(token.mint))
              previous.relatedMints.push(token.mint);
            // One vault is counted once; the freshest observed amount wins.
            previous.amountRaw = amount;
            previous.spendableRaw = spendable;
          } else {
            uniqueComponents.push(component);
            if (
              (component.quoteMint ?? plan.quoteAsset.mint.toBase58()) ===
              plan.quoteAsset.mint.toBase58()
            ) {
              uniqueEstimate += amount;
              uniqueSpendable += spendable;
            }
            groups.set(component.key, {
              key: component.key,
              source: plan.source,
              quoteMint: component.quoteMint ?? plan.quoteAsset.mint.toBase58(),
              quoteDecimals:
                component.quoteDecimals ?? plan.quoteAsset.decimals,
              amountRaw: amount,
              spendableRaw: spendable,
              relatedMints: [token.mint],
              attribution:
                plan.meta?.attribution === "shared-creator-vault" ||
                plan.meta?.attribution === "mint-sharing-vault"
                  ? plan.meta.attribution
                  : "source-defined",
            });
          }
        }
        const instructions = (hasValue ? plan.instructions : []).filter(
          (ix) => {
            const key = `${ix.programId.toBase58()}:${ix.data.toString("base64")}:${ix.keys.map((item) => `${item.pubkey.toBase58()}:${item.isSigner}:${item.isWritable}`).join(",")}`;
            if (instructionKeys.has(key)) return false;
            instructionKeys.add(key);
            return true;
          },
        );
        if (instructions.length && hasValue)
          plans.push({
            ...plan,
            instructions,
            estimatedClaimRaw: uniqueEstimate,
            spendableByUserRaw: uniqueSpendable,
            meta: { ...plan.meta, claimComponents: uniqueComponents },
          });
        items.push({
          mint: token.mint,
          source: plan.source,
          status: hasValue ? "claimable" : "empty",
          groupKeys: keys,
        });
      }
    } catch (error) {
      items.push({
        mint: token.mint,
        source: null,
        status: "error",
        groupKeys: [],
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    wallet: wallet.toBase58(),
    items,
    groups: [...groups.values()],
    plans,
  };
}

/** Bounded construction batches; host compilation still enforces serialized size before signing. */
export function batchCreatorFeePlans(
  plans: ReadonlyArray<ClaimPlan>,
  maxInstructions = 12,
): Array<Array<ClaimPlan>> {
  if (
    !Number.isInteger(maxInstructions) ||
    maxInstructions < 1 ||
    maxInstructions > 64
  )
    throw new Error("Invalid claim batch instruction limit");
  const batches: Array<Array<ClaimPlan>> = [];
  let current: Array<ClaimPlan> = [],
    size = 0;
  for (const plan of plans) {
    if (plan.instructions.length > maxInstructions)
      throw new Error(
        `Claim source ${plan.source} exceeds batch instruction limit`,
      );
    if (size + plan.instructions.length > maxInstructions) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(plan);
    size += plan.instructions.length;
  }
  if (current.length) batches.push(current);
  return batches;
}
