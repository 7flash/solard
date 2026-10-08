import { expect, test } from "bun:test";
import { PublicKey, type Connection } from "@solana/web3.js";
import {
  MintLayout,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  NATIVE_MINT,
} from "@solana/spl-token";
import {
  CpmmPoolInfoLayout,
  CREATE_CPMM_POOL_PROGRAM,
} from "@raydium-io/raydium-sdk-v2";
import { resolveCurrentMarket } from "./current-market.ts";
import { decodeCpmmSwap } from "./raydium-cpmm-events.ts";

test("current CPMM market verifies both mint programs and supply, including opposite mint ordering", async () => {
  const base = new PublicKey(new Uint8Array(32).fill(3));
  const address = new PublicKey(new Uint8Array(32).fill(4));
  const data = Buffer.alloc(CpmmPoolInfoLayout.span);
  const pool = CpmmPoolInfoLayout.decode(data);
  Object.assign(pool, {
    mintA: NATIVE_MINT,
    mintB: base,
    mintProgramA: TOKEN_PROGRAM_ID,
    mintProgramB: TOKEN_2022_PROGRAM_ID,
  });
  CpmmPoolInfoLayout.encode(pool, data);
  Buffer.from([247, 237, 227, 245, 215, 195, 222, 70]).copy(data);
  const mintData = (decimals: number) => {
    const bytes = Buffer.alloc(82);
    MintLayout.encode(
      {
        mintAuthorityOption: 0,
        mintAuthority: PublicKey.default,
        supply: 1_000_000_000_000_000n,
        decimals,
        isInitialized: true,
        freezeAuthorityOption: 0,
        freezeAuthority: PublicKey.default,
      },
      bytes,
    );
    return bytes;
  };
  const baseData = Buffer.alloc(166);
  mintData(6).copy(baseData);
  baseData[165] = 1;
  let baseProgram = TOKEN_2022_PROGRAM_ID;
  const connection = {
    getAccountInfo: async () => ({ data, owner: CREATE_CPMM_POOL_PROGRAM }),
    getMultipleAccountsInfo: async () => [
      { data: baseData, owner: baseProgram },
      { data: mintData(9), owner: TOKEN_PROGRAM_ID },
    ],
  } as unknown as Connection;
  const market = await resolveCurrentMarket(connection, base, {
    pool: address,
  });
  expect(market).toMatchObject({
    venue: "raydium-cpmm",
    mint: base.toBase58(),
    quoteMint: NATIVE_MINT.toBase58(),
    baseDecimals: 6,
    quoteDecimals: 9,
    supplyRaw: 1_000_000_000_000_000n,
    livePricesSupported: true,
  });
  baseProgram = TOKEN_PROGRAM_ID;
  await expect(
    resolveCurrentMarket(connection, base, { pool: address }),
  ).rejects.toThrow("token program");
});
test("CPMM event decoder rejects old layouts without mint identity", () => {
  const bytes = Buffer.alloc(170);
  Buffer.from([64, 198, 205, 232, 38, 8, 113, 226]).copy(bytes);
  new PublicKey(new Uint8Array(32).fill(7)).toBuffer().copy(bytes, 89);
  NATIVE_MINT.toBuffer().copy(bytes, 121);
  expect(decodeCpmmSwap(bytes)?.inputMint).toBe(
    new PublicKey(new Uint8Array(32).fill(7)).toBase58(),
  );
  expect(decodeCpmmSwap(bytes.subarray(0, 89))).toBeNull();
});
