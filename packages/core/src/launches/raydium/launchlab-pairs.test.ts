import { test, expect } from "bun:test";
import { Keypair, SystemProgram } from "@solana/web3.js";
import {
  LaunchpadConfig,
  LAUNCHPAD_PROGRAM,
  getPdaLaunchpadConfigId,
  getPdaPlatformAllowConfig,
} from "@raydium-io/raydium-sdk-v2";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { getSupportedLaunchLabPairs } from "./launchlab-pairs.ts";
import accountsIdl from "../../venues/raydium/launchlab-accounts.json";

test("LaunchLab pair discovery verifies config PDA, platform allowlist and quote mint metadata", async () => {
  const platform = Keypair.generate().publicKey,
    mint = Keypair.generate().publicKey;
  const config = getPdaLaunchpadConfigId(
    LAUNCHPAD_PROGRAM,
    mint,
    0,
    0,
  ).publicKey;
  const allow = getPdaPlatformAllowConfig(
    LAUNCHPAD_PROGRAM,
    platform,
    config,
  ).publicKey;
  const platformData = Buffer.alloc(4096);
  platformData[832] = 1;
  const configData = Buffer.alloc(LaunchpadConfig.span);
  mint.toBuffer().copy(configData, LaunchpadConfig.offsetOf("mintB"));
  Buffer.from(
    accountsIdl.accounts.find((account) => account.name === "PlatformConfig")!
      .discriminator,
  ).copy(platformData);
  Buffer.from(
    accountsIdl.accounts.find((account) => account.name === "GlobalConfig")!
      .discriminator,
  ).copy(configData);
  const mintData = Buffer.alloc(82);
  mintData[44] = 6;
  mintData[45] = 1;
  const account = (data: Buffer, owner = LAUNCHPAD_PROGRAM) => ({
    data,
    owner,
    lamports: 1,
    executable: false,
    rentEpoch: 0,
  });
  let allowed = true;
  let mintOwner = TOKEN_2022_PROGRAM_ID;
  const batches: number[] = [];
  const connection = {
    getAccountInfo: async () => account(platformData),
    getProgramAccounts: async () => [
      { pubkey: config, account: account(configData) },
      { pubkey: Keypair.generate().publicKey, account: account(configData) },
    ],
    getMultipleAccountsInfo: async (keys: any[]) => {
      batches.push(keys.length);
      return keys.map((key) =>
        key.equals(mint)
          ? account(mintData, mintOwner)
          : key.equals(allow) && allowed
            ? account(Buffer.alloc(8))
            : null,
      );
    },
  } as any;
  expect(await getSupportedLaunchLabPairs(connection, platform)).toEqual([
    {
      platformConfig: platform.toBase58(),
      launchConfig: config.toBase58(),
      quoteMint: mint.toBase58(),
      quoteDecimals: 6,
      quoteTokenProgram: TOKEN_2022_PROGRAM_ID.toBase58(),
      curveType: 0,
      configIndex: 0,
      launchParametersRequireValidation: false,
      curveRule: null,
    },
  ]);
  expect(batches).toEqual([2]);
  allowed = false;
  expect(await getSupportedLaunchLabPairs(connection, platform)).toEqual([]);
  allowed = true;
  mintOwner = SystemProgram.programId;
  expect(await getSupportedLaunchLabPairs(connection, platform)).toEqual([]);
  platformData[833] = 1;
  mintOwner = TOKEN_2022_PROGRAM_ID;
  expect(await getSupportedLaunchLabPairs(connection, platform)).toEqual([]);
});
