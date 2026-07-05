import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
export const PUMP_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
export const PUMP_AMM_PROGRAM_ID = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
export const MAYHEM_PROGRAM_ID = new PublicKey("MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e");
export const PUMP_FEE_PROGRAM_ID = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
export const WRAPPED_SOL_MINT = NATIVE_MINT;
export const SPL_TOKEN_PROGRAM_ID = TOKEN_PROGRAM_ID;
export const TOKEN_2022_ID = TOKEN_2022_PROGRAM_ID;
export const PUMP_BREAKING_FEE_RECIPIENTS = [
  "5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD",
  "9M4giFFMxmFGXtc3feFzRai56WbBqehoSeRE5GK7gf7",
  "GXPFM2caqTtQYC2cJ5yJRi9VDkpsYZXzYdwYpGnLmtDL",
  "3BpXnfJaUTiwXnJNe7Ej1rcbzqTTQUvLShZaWazebsVR",
  "5cjcW9wExnJJiqgLjq7DE75Pm6JBgE1hNv4B2vHXUW6",
  "EHAAiTxcdDwQ3U4bU6YcMsQGaekdzLS3B5SmYo46kJtL",
  "5eHhjP8JaYkz83CWwvGU2uMUXefd3AazWGx4gpcuEEYD",
  "A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW",
].map((value) => new PublicKey(value));
export const CREATE_V2_D8 = Buffer.from([214, 144, 76, 236, 95, 139, 49, 180]);
export const BUY_EXACT_QUOTE_IN_V2_D8 = Buffer.from([194, 171, 28, 70, 104, 77, 91, 47]);
export const SELL_V2_D8 = Buffer.from([93, 246, 130, 60, 231, 233, 64, 178]);
export const AMM_BUY_D8 = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
// Current PumpSwap budget-based buy: spendable_quote_in, min_base_amount_out, track_volume.
export const AMM_BUY_EXACT_QUOTE_IN_D8 = Buffer.from([198, 46, 21, 82, 180, 217, 232, 112]);
export const AMM_SELL_D8 = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);
export const PUMP_FEE_CONFIG_SEED = Buffer.from([1, 86, 224, 246, 147, 102, 90, 207, 68, 219, 21, 104, 191, 23, 91, 170, 81, 137, 203, 151, 245, 210, 255, 59, 101, 93, 43, 182, 253, 109, 24, 176]);
export const AMM_FEE_CONFIG_SEED = Buffer.from([12, 20, 222, 252, 130, 94, 198, 118, 148, 37, 8, 24, 187, 101, 64, 101, 244, 41, 141, 49, 86, 213, 113, 180, 212, 248, 9, 12, 24, 233, 168, 99]);
