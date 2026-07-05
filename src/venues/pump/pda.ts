import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import {
  AMM_FEE_CONFIG_SEED,
  MAYHEM_PROGRAM_ID,
  PUMP_AMM_PROGRAM_ID,
  PUMP_FEE_CONFIG_SEED,
  PUMP_FEE_PROGRAM_ID,
  PUMP_PROGRAM_ID,
} from "./constants.js";
export function pda(programId: PublicKey, ...seeds: Buffer[]): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}
export const globalPda = () => pda(PUMP_PROGRAM_ID, Buffer.from("global"));
export const mintAuthorityPda = () =>
  pda(PUMP_PROGRAM_ID, Buffer.from("mint-authority"));
export const bondingCurvePda = (mint: PublicKey) =>
  pda(PUMP_PROGRAM_ID, Buffer.from("bonding-curve"), mint.toBuffer());
export const bondingCurveV2Pda = (mint: PublicKey) =>
  pda(PUMP_PROGRAM_ID, Buffer.from("bonding-curve-v2"), mint.toBuffer());
export const creatorVaultPda = (creator: PublicKey) =>
  pda(PUMP_PROGRAM_ID, Buffer.from("creator-vault"), creator.toBuffer());
export const pumpPoolAuthorityPda = (mint: PublicKey) =>
  pda(PUMP_PROGRAM_ID, Buffer.from("pool-authority"), mint.toBuffer());
export function pumpSwapPoolPda(
  baseMint: PublicKey,
  quoteMint: PublicKey,
  index = 0,
): PublicKey {
  const indexBytes = Buffer.alloc(2);
  indexBytes.writeUInt16LE(index);
  return pda(
    PUMP_AMM_PROGRAM_ID,
    Buffer.from("pool"),
    indexBytes,
    pumpPoolAuthorityPda(baseMint).toBuffer(),
    baseMint.toBuffer(),
    quoteMint.toBuffer(),
  );
}
export const pumpEventAuthorityPda = () =>
  pda(PUMP_PROGRAM_ID, Buffer.from("__event_authority"));
export const mayhemGlobalParamsPda = () =>
  pda(MAYHEM_PROGRAM_ID, Buffer.from("global-params"));
export const mayhemSolVaultPda = () =>
  pda(MAYHEM_PROGRAM_ID, Buffer.from("sol-vault"));
export const mayhemStatePda = (mint: PublicKey) =>
  pda(MAYHEM_PROGRAM_ID, Buffer.from("mayhem-state"), mint.toBuffer());
export const sharingConfigPda = (mint: PublicKey) =>
  pda(PUMP_FEE_PROGRAM_ID, Buffer.from("sharing-config"), mint.toBuffer());
export const globalVolumeAccumulatorPda = () =>
  pda(PUMP_PROGRAM_ID, Buffer.from("global_volume_accumulator"));
export const userVolumeAccumulatorPda = (user: PublicKey) =>
  pda(PUMP_PROGRAM_ID, Buffer.from("user_volume_accumulator"), user.toBuffer());
export const pumpFeeConfigPda = () =>
  pda(PUMP_FEE_PROGRAM_ID, Buffer.from("fee_config"), PUMP_FEE_CONFIG_SEED);
export const ammGlobalConfigPda = () =>
  pda(PUMP_AMM_PROGRAM_ID, Buffer.from("global_config"));
export const ammCreatorVaultPda = (creator: PublicKey) =>
  pda(PUMP_AMM_PROGRAM_ID, Buffer.from("creator_vault"), creator.toBuffer());
export const ammEventAuthorityPda = () =>
  pda(PUMP_AMM_PROGRAM_ID, Buffer.from("__event_authority"));
export const ammGlobalVolumeAccumulatorPda = () =>
  pda(PUMP_AMM_PROGRAM_ID, Buffer.from("global_volume_accumulator"));
export const ammUserVolumeAccumulatorPda = (user: PublicKey) =>
  pda(
    PUMP_AMM_PROGRAM_ID,
    Buffer.from("user_volume_accumulator"),
    user.toBuffer(),
  );
export const ammFeeConfigPda = () =>
  pda(PUMP_FEE_PROGRAM_ID, Buffer.from("fee_config"), AMM_FEE_CONFIG_SEED);
export const ammPoolV2Pda = (baseMint: PublicKey) =>
  pda(PUMP_AMM_PROGRAM_ID, Buffer.from("pool-v2"), baseMint.toBuffer());
export function ata(
  mint: PublicKey,
  owner: PublicKey,
  tokenProgram: PublicKey,
  offCurve = false,
): PublicKey {
  return getAssociatedTokenAddressSync(
    mint,
    owner,
    offCurve,
    tokenProgram,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
}
