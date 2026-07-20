import { ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type AccountMeta,
} from "@solana/web3.js";
import type { QuoteAsset } from "../../core/amounts.ts";
import type { TokenRow } from "../../db/schema.ts";
import { PUMP_PROGRAM_ID } from "./constants.ts";
import { anchorDiscriminator } from "./anchor.ts";
import {
  ata,
  bondingCurvePda,
  creatorVaultPda,
  pumpEventAuthorityPda,
  sharingConfigPda,
} from "./pda.ts";
import {
  buildCollectCoinCreatorFee,
  buildTransferCreatorFeesToPumpV2,
} from "./pumpswap-instructions.ts";
import { buildCollectCreatorFeeV2 } from "./pump-instructions.ts";

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
function buildDistributeCreatorFeesV2(args: {
  token: TokenRow;
  caller: PublicKey;
  quote: QuoteAsset;
  shareholderAddresses: PublicKey[];
}): TransactionInstruction {
  const mint = new PublicKey(args.token.mint);
  const sharing = sharingConfigPda(mint);
  const vault = creatorVaultPda(sharing);
  if (!args.shareholderAddresses.length)
    throw new Error("Sharing config has no shareholders");
  const remaining =
    args.quote.kind === "native-sol"
      ? args.shareholderAddresses.map((address) => wr(address))
      : [
          ...args.shareholderAddresses.map((address) => wr(address)),
          ...args.shareholderAddresses.map((address) =>
            wr(ata(args.quote.mint, address, args.quote.tokenProgram, true)),
          ),
        ];
  return new TransactionInstruction({
    programId: PUMP_PROGRAM_ID,
    keys: [
      wr(args.caller, true),
      ro(mint),
      ro(bondingCurvePda(mint)),
      ro(sharing),
      wr(vault),
      ro(SystemProgram.programId),
      ro(pumpEventAuthorityPda()),
      ro(PUMP_PROGRAM_ID),
      wr(ata(args.quote.mint, vault, args.quote.tokenProgram, true)),
      ro(args.quote.mint),
      ro(args.quote.tokenProgram),
      ro(ASSOCIATED_TOKEN_PROGRAM_ID),
      ...remaining,
    ],
    data: Buffer.concat([
      anchorDiscriminator("distribute_creator_fees_v2"),
      Buffer.from([1]),
    ]),
  });
}
export function buildClaimInstructions(args: {
  token: TokenRow;
  caller: PublicKey;
  creator: PublicKey;
  quote: QuoteAsset;
  includeAmm: boolean;
  sharingConfig: boolean;
  coinCreator?: PublicKey;
  shareholderAddresses?: PublicKey[];
}): TransactionInstruction[] {
  if (args.sharingConfig) {
    const sharing = sharingConfigPda(new PublicKey(args.token.mint));
    const instructions: TransactionInstruction[] = [];
    if (args.includeAmm) {
      instructions.push(
        buildTransferCreatorFeesToPumpV2({
          caller: args.caller,
          coinCreator: args.coinCreator ?? sharing,
          quote: args.quote,
        }),
      );
    }
    instructions.push(
      buildDistributeCreatorFeesV2({
        token: args.token,
        caller: args.caller,
        quote: args.quote,
        shareholderAddresses: args.shareholderAddresses ?? [],
      }),
    );
    return instructions;
  }
  const instructions = buildCollectCreatorFeeV2({
    caller: args.caller,
    creator: args.creator,
    quote: args.quote,
  });
  if (args.includeAmm && args.coinCreator)
    instructions.push(
      ...buildCollectCoinCreatorFee({
        caller: args.caller,
        coinCreator: args.coinCreator,
        quote: args.quote,
      }),
    );
  return instructions;
}
