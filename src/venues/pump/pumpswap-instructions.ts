import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createSyncNativeInstruction,
} from "@solana/spl-token";
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type AccountMeta,
} from "@solana/web3.js";
import type { QuoteAsset } from "../../core/amounts.js";
import {
  AMM_BUY_D8,
  AMM_BUY_EXACT_QUOTE_IN_D8,
  AMM_SELL_D8,
  PUMP_AMM_PROGRAM_ID,
  PUMP_BREAKING_FEE_RECIPIENTS,
  PUMP_FEE_PROGRAM_ID,
} from "./constants.js";
import { anchorDiscriminator, optionBool, u64 } from "./anchor.js";
import {
  ammCreatorVaultPda,
  ammEventAuthorityPda,
  ammFeeConfigPda,
  ammGlobalVolumeAccumulatorPda,
  ammUserVolumeAccumulatorPda,
  ammPoolV2Pda,
  ata,
  creatorVaultPda,
} from "./pda.js";
import { ensureAtaIx } from "./pump-instructions.js";

const ro = (pubkey: PublicKey): AccountMeta => ({
  pubkey,
  isSigner: false,
  isWritable: false,
});
const wr = (pubkey: PublicKey, signer = false): AccountMeta => ({
  pubkey,
  isSigner: signer,
  isWritable: true,
});

export type PumpSwapAccounts = {
  pool: PublicKey;
  globalConfig: PublicKey;
  baseMint: PublicKey;
  quote: QuoteAsset;
  baseTokenProgram: PublicKey;
  poolBaseAta: PublicKey;
  poolQuoteAta: PublicKey;
  protocolFeeRecipient: PublicKey;
  coinCreator: PublicKey;
  user: PublicKey;
  cashbackRemainingAccounts?: AccountMeta[];
};
function pickBreakingFeeRecipient(baseMint: PublicKey): PublicKey {
  return PUMP_BREAKING_FEE_RECIPIENTS[
    baseMint.toBytes()[0]! % PUMP_BREAKING_FEE_RECIPIENTS.length
  ]!;
}
function upgradedTail(a: PumpSwapAccounts): AccountMeta[] {
  const feeRecipient = pickBreakingFeeRecipient(a.baseMint);
  return [
    ro(ammPoolV2Pda(a.baseMint)),
    ro(feeRecipient),
    wr(ata(a.quote.mint, feeRecipient, a.quote.tokenProgram, true)),
  ];
}
function coreAccounts(a: PumpSwapAccounts): AccountMeta[] {
  return [
    wr(a.pool),
    wr(a.user, true),
    ro(a.globalConfig),
    ro(a.baseMint),
    ro(a.quote.mint),
    wr(ata(a.baseMint, a.user, a.baseTokenProgram)),
    wr(ata(a.quote.mint, a.user, a.quote.tokenProgram)),
    wr(a.poolBaseAta),
    wr(a.poolQuoteAta),
    ro(a.protocolFeeRecipient),
    wr(ata(a.quote.mint, a.protocolFeeRecipient, a.quote.tokenProgram, true)),
    ro(a.baseTokenProgram),
    ro(a.quote.tokenProgram),
    ro(SystemProgram.programId),
    ro(ASSOCIATED_TOKEN_PROGRAM_ID),
    ro(ammEventAuthorityPda()),
    ro(PUMP_AMM_PROGRAM_ID),
  ];
}
/**
 * Legacy exact-base-output PumpSwap buy. Prefer buildPumpSwapBuyExactQuoteIn
 * when the caller starts from a quote-asset spending budget (`--sol`, claimed
 * funds, agent budget).
 */
export function buildPumpSwapBuy(
  args: PumpSwapAccounts & {
    baseOutRaw: bigint;
    maxQuoteInRaw: bigint;
    trackVolume?: boolean;
  },
): TransactionInstruction[] {
  const quoteAta = ata(args.quote.mint, args.user, args.quote.tokenProgram);
  const setup = [
    ensureAtaIx(args.user, args.baseMint, args.user, args.baseTokenProgram),
    ensureAtaIx(args.user, args.quote.mint, args.user, args.quote.tokenProgram),
  ];
  if (args.quote.kind === "native-sol") {
    setup.push(
      SystemProgram.transfer({
        fromPubkey: args.user,
        toPubkey: quoteAta,
        lamports: args.maxQuoteInRaw,
      }),
    );
    setup.push(createSyncNativeInstruction(quoteAta, args.quote.tokenProgram));
  }
  return [
    ...setup,
    new TransactionInstruction({
      programId: PUMP_AMM_PROGRAM_ID,
      keys: [
        ...coreAccounts(args),
        wr(
          ata(
            args.quote.mint,
            ammCreatorVaultPda(args.coinCreator),
            args.quote.tokenProgram,
            true,
          ),
        ),
        ro(ammCreatorVaultPda(args.coinCreator)),
        ro(ammGlobalVolumeAccumulatorPda()),
        wr(ammUserVolumeAccumulatorPda(args.user)),
        ro(ammFeeConfigPda()),
        ro(PUMP_FEE_PROGRAM_ID),
        ...(args.cashbackRemainingAccounts ?? []),
        ...upgradedTail(args),
      ],
      data: Buffer.concat([
        AMM_BUY_D8,
        u64(args.baseOutRaw),
        u64(args.maxQuoteInRaw),
        optionBool(args.trackVolume ?? true),
      ]),
    }),
  ];
}

/**
 * PumpSwap buy for a quote-asset spending budget. This is the correct wire
 * instruction for `sowl buy ... --sol <amount>` and for script budgets: the
 * on-chain program deducts fees from spendableQuoteInRaw and enforces only
 * the minimum base output.
 */
export function buildPumpSwapBuyExactQuoteIn(
  args: PumpSwapAccounts & {
    spendableQuoteInRaw: bigint;
    minBaseOutRaw: bigint;
    trackVolume?: boolean;
  },
): TransactionInstruction[] {
  const quoteAta = ata(args.quote.mint, args.user, args.quote.tokenProgram);
  const setup = [
    ensureAtaIx(args.user, args.baseMint, args.user, args.baseTokenProgram),
    ensureAtaIx(args.user, args.quote.mint, args.user, args.quote.tokenProgram),
  ];
  if (args.quote.kind === "native-sol") {
    setup.push(
      SystemProgram.transfer({
        fromPubkey: args.user,
        toPubkey: quoteAta,
        lamports: args.spendableQuoteInRaw,
      }),
    );
    setup.push(createSyncNativeInstruction(quoteAta, args.quote.tokenProgram));
  }
  return [
    ...setup,
    new TransactionInstruction({
      programId: PUMP_AMM_PROGRAM_ID,
      keys: [
        ...coreAccounts(args),
        wr(
          ata(
            args.quote.mint,
            ammCreatorVaultPda(args.coinCreator),
            args.quote.tokenProgram,
            true,
          ),
        ),
        ro(ammCreatorVaultPda(args.coinCreator)),
        ro(ammGlobalVolumeAccumulatorPda()),
        wr(ammUserVolumeAccumulatorPda(args.user)),
        ro(ammFeeConfigPda()),
        ro(PUMP_FEE_PROGRAM_ID),
        ...(args.cashbackRemainingAccounts ?? []),
        ...upgradedTail(args),
      ],
      data: Buffer.concat([
        AMM_BUY_EXACT_QUOTE_IN_D8,
        u64(args.spendableQuoteInRaw),
        u64(args.minBaseOutRaw),
        optionBool(args.trackVolume ?? true),
      ]),
    }),
  ];
}
export function buildPumpSwapSell(
  args: PumpSwapAccounts & { baseInRaw: bigint; minQuoteOutRaw: bigint },
): TransactionInstruction[] {
  return [
    ensureAtaIx(args.user, args.quote.mint, args.user, args.quote.tokenProgram),
    new TransactionInstruction({
      programId: PUMP_AMM_PROGRAM_ID,
      keys: [
        ...coreAccounts(args),
        wr(
          ata(
            args.quote.mint,
            ammCreatorVaultPda(args.coinCreator),
            args.quote.tokenProgram,
            true,
          ),
        ),
        ro(ammCreatorVaultPda(args.coinCreator)),
        ro(ammFeeConfigPda()),
        ro(PUMP_FEE_PROGRAM_ID),
        ...(args.cashbackRemainingAccounts ?? []),
        ...upgradedTail(args),
      ],
      data: Buffer.concat([
        AMM_SELL_D8,
        u64(args.baseInRaw),
        u64(args.minQuoteOutRaw),
      ]),
    }),
  ];
}
export function buildCollectCoinCreatorFee(args: {
  caller: PublicKey;
  coinCreator: PublicKey;
  quote: QuoteAsset;
}): TransactionInstruction[] {
  const vault = ammCreatorVaultPda(args.coinCreator);
  return [
    ensureAtaIx(
      args.caller,
      args.quote.mint,
      args.coinCreator,
      args.quote.tokenProgram,
    ),
    new TransactionInstruction({
      programId: PUMP_AMM_PROGRAM_ID,
      keys: [
        ro(args.quote.mint),
        ro(args.quote.tokenProgram),
        wr(args.coinCreator),
        ro(vault),
        wr(ata(args.quote.mint, vault, args.quote.tokenProgram, true)),
        wr(ata(args.quote.mint, args.coinCreator, args.quote.tokenProgram)),
        ro(ammEventAuthorityPda()),
        ro(PUMP_AMM_PROGRAM_ID),
      ],
      data: anchorDiscriminator("collect_coin_creator_fee"),
    }),
  ];
}
/** Sweeps the AMM vault into Pump's creator vault for sharing_config recipients. */
export function buildTransferCreatorFeesToPumpV2(args: {
  caller: PublicKey;
  coinCreator: PublicKey;
  quote: QuoteAsset;
}): TransactionInstruction {
  const ammVault = ammCreatorVaultPda(args.coinCreator);
  const pumpVault = creatorVaultPda(args.coinCreator);
  return new TransactionInstruction({
    programId: PUMP_AMM_PROGRAM_ID,
    keys: [
      wr(args.caller, true),
      ro(args.quote.mint),
      ro(args.quote.tokenProgram),
      ro(SystemProgram.programId),
      ro(ASSOCIATED_TOKEN_PROGRAM_ID),
      ro(args.coinCreator),
      wr(ammVault),
      wr(ata(args.quote.mint, ammVault, args.quote.tokenProgram, true)),
      wr(pumpVault),
      wr(ata(args.quote.mint, pumpVault, args.quote.tokenProgram, true)),
      ro(ammEventAuthorityPda()),
      ro(PUMP_AMM_PROGRAM_ID),
    ],
    data: anchorDiscriminator("transfer_creator_fees_to_pump_v2"),
  });
}
