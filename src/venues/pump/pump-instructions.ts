import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import type { QuoteAsset } from "../../core/amounts.js";
import type { PumpRouting } from "./routing.js";
import {
  BUY_EXACT_QUOTE_IN_V2_D8,
  CREATE_V2_D8,
  MAYHEM_PROGRAM_ID,
  PUMP_BREAKING_FEE_RECIPIENTS,
  PUMP_FEE_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  SELL_V2_D8,
  TOKEN_2022_ID,
} from "./constants.js";
import {
  anchorDiscriminator,
  bool,
  optionBool,
  string,
  u64,
} from "./anchor.js";
import {
  ata,
  bondingCurvePda,
  bondingCurveV2Pda,
  creatorVaultPda,
  globalPda,
  globalVolumeAccumulatorPda,
  mayhemGlobalParamsPda,
  mayhemSolVaultPda,
  mayhemStatePda,
  mintAuthorityPda,
  pumpEventAuthorityPda,
  pumpFeeConfigPda,
  sharingConfigPda,
  userVolumeAccumulatorPda,
} from "./pda.js";

const ro = (pubkey: PublicKey) => ({
  pubkey,
  isSigner: false,
  isWritable: false,
});
const wr = (pubkey: PublicKey, signer = false) => ({
  pubkey,
  isSigner: signer,
  isWritable: true,
});

type CurveInstructionArgs = {
  mint: PublicKey;
  user: PublicKey;
  baseTokenProgram: PublicKey;
  quote: QuoteAsset;
  routing: PumpRouting;
};

function breakingFeeRecipient(mint: PublicKey): PublicKey {
  return PUMP_BREAKING_FEE_RECIPIENTS[
    mint.toBytes()[0]! % PUMP_BREAKING_FEE_RECIPIENTS.length
  ]!;
}

export function ensureAtaIx(
  payer: PublicKey,
  mint: PublicKey,
  owner: PublicKey,
  tokenProgram: PublicKey,
  offCurve = false,
): TransactionInstruction {
  return createAssociatedTokenAccountIdempotentInstruction(
    payer,
    ata(mint, owner, tokenProgram, offCurve),
    owner,
    mint,
    tokenProgram,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
}

function curveSharedKeys(args: CurveInstructionArgs) {
  const curve = bondingCurvePda(args.mint);

  return [
    ro(globalPda()),
    ro(args.mint),
    ro(args.quote.mint),
    ro(args.baseTokenProgram),
    ro(args.quote.tokenProgram),
    ro(ASSOCIATED_TOKEN_PROGRAM_ID),
    wr(args.routing.feeRecipient),
    wr(args.routing.associatedQuoteFeeRecipient),
    wr(args.routing.buybackFeeRecipient),
    wr(args.routing.associatedQuoteBuybackFeeRecipient),
    wr(curve),
    wr(ata(args.mint, curve, args.baseTokenProgram, true)),
    wr(ata(args.quote.mint, curve, args.quote.tokenProgram, true)),
    wr(args.user, true),
    wr(ata(args.mint, args.user, args.baseTokenProgram)),
    wr(ata(args.quote.mint, args.user, args.quote.tokenProgram)),
    wr(args.routing.creatorVault),
    wr(args.routing.associatedCreatorVault),
    ro(sharingConfigPda(args.mint)),
  ];
}

function curveTrailingKeys(args: CurveInstructionArgs) {
  return [
    ro(bondingCurveV2Pda(args.mint)),
    wr(breakingFeeRecipient(args.mint)),
  ];
}

function curveBuyKeys(args: CurveInstructionArgs) {
  const uva = userVolumeAccumulatorPda(args.user);

  return [
    ...curveSharedKeys(args),
    ro(globalVolumeAccumulatorPda()),
    wr(uva),
    wr(ata(args.quote.mint, uva, args.quote.tokenProgram, true)),
    ro(pumpFeeConfigPda()),
    ro(PUMP_FEE_PROGRAM_ID),
    ro(SystemProgram.programId),
    ro(pumpEventAuthorityPda()),
    ro(PUMP_PROGRAM_ID),
    ...curveTrailingKeys(args),
  ];
}

function curveSellKeys(args: CurveInstructionArgs) {
  const uva = userVolumeAccumulatorPda(args.user);

  return [
    ...curveSharedKeys(args),
    // sell_v2 skips the buy-only global_volume_accumulator account.
    wr(uva),
    wr(ata(args.quote.mint, uva, args.quote.tokenProgram, true)),
    ro(pumpFeeConfigPda()),
    ro(PUMP_FEE_PROGRAM_ID),
    ro(SystemProgram.programId),
    ro(pumpEventAuthorityPda()),
    ro(PUMP_PROGRAM_ID),
    ...curveTrailingKeys(args),
  ];
}

export function buildCreateV2(args: {
  mint: PublicKey;
  user: PublicKey;
  creator: PublicKey;
  name: string;
  symbol: string;
  uri: string;
  quote: QuoteAsset;
  mayhemMode?: boolean;
  cashback?: boolean;
}): TransactionInstruction {
  if (Buffer.byteLength(args.name, "utf8") > 32)
    throw new Error("Pump token name exceeds 32 UTF-8 bytes");
  if (Buffer.byteLength(args.symbol, "utf8") > 13)
    throw new Error("Pump token symbol exceeds 13 UTF-8 bytes");
  if (Buffer.byteLength(args.uri, "utf8") > 200)
    throw new Error("Pump token metadata URI exceeds 200 UTF-8 bytes");
  if (args.creator.equals(PublicKey.default))
    throw new Error("Pump creator cannot be the default public key");

  const curve = bondingCurvePda(args.mint);
  const keys = [
    wr(args.mint, true),
    ro(mintAuthorityPda()),
    wr(curve),
    wr(ata(args.mint, curve, TOKEN_2022_ID, true)),
    ro(globalPda()),
    wr(args.user, true),
    ro(SystemProgram.programId),
    ro(TOKEN_2022_ID),
    ro(ASSOCIATED_TOKEN_PROGRAM_ID),
    wr(MAYHEM_PROGRAM_ID),
    ro(mayhemGlobalParamsPda()),
    wr(mayhemSolVaultPda()),
    wr(mayhemStatePda(args.mint)),
    wr(ata(args.mint, mayhemSolVaultPda(), TOKEN_2022_ID, true)),
    ro(pumpEventAuthorityPda()),
    ro(PUMP_PROGRAM_ID),
  ];

  if (args.quote.kind === "spl-token") {
    keys.push(
      ro(args.quote.mint),
      wr(ata(args.quote.mint, curve, args.quote.tokenProgram, true)),
      ro(args.quote.tokenProgram),
    );
  }

  return new TransactionInstruction({
    programId: PUMP_PROGRAM_ID,
    keys,
    data: Buffer.concat([
      CREATE_V2_D8,
      string(args.name),
      string(args.symbol),
      string(args.uri),
      args.creator.toBuffer(),
      bool(args.mayhemMode ?? false),
      optionBool(args.cashback ?? false),
    ]),
  });
}

export function buildCurveBuyV2(args: {
  mint: PublicKey;
  user: PublicKey;
  baseTokenProgram: PublicKey;
  quote: QuoteAsset;
  routing: PumpRouting;
  quoteInRaw: bigint;
  minBaseOutRaw: bigint;
}): TransactionInstruction[] {
  return [
    ensureAtaIx(args.user, args.mint, args.user, args.baseTokenProgram),
    new TransactionInstruction({
      programId: PUMP_PROGRAM_ID,
      keys: curveBuyKeys(args),
      data: Buffer.concat([
        BUY_EXACT_QUOTE_IN_V2_D8,
        u64(args.quoteInRaw),
        u64(args.minBaseOutRaw),
      ]),
    }),
  ];
}

export function buildCurveSellV2(args: {
  mint: PublicKey;
  user: PublicKey;
  baseTokenProgram: PublicKey;
  quote: QuoteAsset;
  routing: PumpRouting;
  baseInRaw: bigint;
  minQuoteOutRaw: bigint;
}): TransactionInstruction[] {
  return [
    new TransactionInstruction({
      programId: PUMP_PROGRAM_ID,
      keys: curveSellKeys(args),
      data: Buffer.concat([
        SELL_V2_D8,
        u64(args.baseInRaw),
        u64(args.minQuoteOutRaw),
      ]),
    }),
  ];
}

export function buildCollectCreatorFeeV2(args: {
  caller: PublicKey;
  creator: PublicKey;
  quote: QuoteAsset;
  routingCreatorVault?: PublicKey;
}): TransactionInstruction[] {
  const creatorVault =
    args.routingCreatorVault ?? creatorVaultPda(args.creator);
  const setup =
    args.quote.kind === "spl-token"
      ? [
          ensureAtaIx(
            args.caller,
            args.quote.mint,
            args.creator,
            args.quote.tokenProgram,
          ),
        ]
      : [];

  return [
    ...setup,
    new TransactionInstruction({
      programId: PUMP_PROGRAM_ID,
      keys: [
        wr(args.creator),
        wr(ata(args.quote.mint, args.creator, args.quote.tokenProgram)),
        wr(creatorVault),
        wr(ata(args.quote.mint, creatorVault, args.quote.tokenProgram, true)),
        ro(args.quote.mint),
        ro(args.quote.tokenProgram),
        ro(ASSOCIATED_TOKEN_PROGRAM_ID),
        ro(SystemProgram.programId),
        ro(pumpEventAuthorityPda()),
        ro(PUMP_PROGRAM_ID),
      ],
      data: anchorDiscriminator("collect_creator_fee_v2"),
    }),
  ];
}
