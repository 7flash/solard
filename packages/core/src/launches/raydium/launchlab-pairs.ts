import { PublicKey, type Connection } from "@solana/web3.js";
import {
  unpackMint,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import {
  LaunchpadConfig,
  LAUNCHPAD_PROGRAM,
  getPdaLaunchpadConfigId,
  getPdaPlatformAllowConfig,
} from "@raydium-io/raydium-sdk-v2";
import { resolveLaunchLabPlatform } from "../launchlab/launchlab-launchpad.ts";
import accountsIdl from "../../venues/raydium/launchlab-accounts.json";
function matchesAccount(data: Buffer, name: string): boolean {
  const discriminator = accountsIdl.accounts.find(
    (account) => account.name === name,
  )?.discriminator;
  return (
    !!discriminator &&
    data.subarray(0, discriminator.length).equals(Buffer.from(discriminator))
  );
}

export type SupportedLaunchLabPair = {
  platformConfig: string;
  launchConfig: string;
  quoteMint: string;
  quoteDecimals: number;
  quoteTokenProgram: string;
  curveType: number;
  configIndex: number;
  launchParametersRequireValidation: boolean;
  curveRule: string | null;
};
/** On-chain configuration eligibility; parameter rules and simulation still govern a launch. */
export async function getSupportedLaunchLabPairs(
  connection: Connection,
  platformConfig: string | PublicKey,
): Promise<SupportedLaunchLabPair[]> {
  const platformId = resolveLaunchLabPlatform(platformConfig);
  const account = await connection.getAccountInfo(platformId, "confirmed");
  if (
    !account?.owner.equals(LAUNCHPAD_PROGRAM) ||
    account.data.length < 944 ||
    !matchesAccount(account.data, "PlatformConfig")
  )
    throw new Error("Invalid LaunchLab platform config owner or layout");
  // Restriction bytes follow platformCpCreator in the published protocol layout;
  // older SDK runtime decoders omit these fields.
  const platform = {
    restrictGlobalConfig: account.data[832]!,
    restrictCurveParam: account.data[833]!,
  };
  if (
    ![0, 1].includes(platform.restrictGlobalConfig) ||
    ![0, 1].includes(platform.restrictCurveParam)
  )
    throw new Error("Unsupported LaunchLab platform restrictions");
  const candidates = (
    await connection.getProgramAccounts(LAUNCHPAD_PROGRAM, {
      commitment: "confirmed",
      filters: [{ dataSize: LaunchpadConfig.span }],
    })
  ).flatMap(({ pubkey, account }) => {
    if (
      !account.owner.equals(LAUNCHPAD_PROGRAM) ||
      !matchesAccount(account.data, "GlobalConfig")
    )
      return [];
    const config = LaunchpadConfig.decode(account.data);
    if (
      !pubkey.equals(
        getPdaLaunchpadConfigId(
          LAUNCHPAD_PROGRAM,
          config.mintB,
          config.curveType,
          config.index,
        ).publicKey,
      )
    )
      return [];
    // SDK source pda.ts defines this seed; this installed runtime omits its helper export.
    return [
      {
        pubkey,
        config,
        allow: getPdaPlatformAllowConfig(LAUNCHPAD_PROGRAM, platformId, pubkey)
          .publicKey,
        rule: PublicKey.findProgramAddressSync(
          [
            Buffer.from("platform_curve_rule"),
            platformId.toBuffer(),
            pubkey.toBuffer(),
          ],
          LAUNCHPAD_PROGRAM,
        )[0],
      },
    ];
  });
  const requests = new Map<string, PublicKey>();
  for (const candidate of candidates) {
    requests.set(candidate.config.mintB.toBase58(), candidate.config.mintB);
    if (platform.restrictGlobalConfig)
      requests.set(candidate.allow.toBase58(), candidate.allow);
    if (platform.restrictCurveParam)
      requests.set(candidate.rule.toBase58(), candidate.rule);
  }
  const keys = [...requests.values()];
  const fetched = new Map<
    string,
    Awaited<ReturnType<Connection["getAccountInfo"]>>
  >();
  for (let offset = 0; offset < keys.length; offset += 100) {
    const batch = keys.slice(offset, offset + 100);
    const accounts = await connection.getMultipleAccountsInfo(
      batch,
      "confirmed",
    );
    batch.forEach((key, index) =>
      fetched.set(key.toBase58(), accounts[index] ?? null),
    );
  }
  return candidates
    .flatMap((candidate) => {
      const mintAccount = fetched.get(candidate.config.mintB.toBase58());
      if (
        !mintAccount ||
        (!mintAccount.owner.equals(TOKEN_PROGRAM_ID) &&
          !mintAccount.owner.equals(TOKEN_2022_PROGRAM_ID))
      )
        return [];
      if (platform.restrictGlobalConfig) {
        const allow = fetched.get(candidate.allow.toBase58());
        // The program-owned, config-specific PDA is the authoritative allow-list entry.
        if (!allow?.owner.equals(LAUNCHPAD_PROGRAM) || allow.data.length < 8)
          return [];
      }
      if (platform.restrictCurveParam) {
        const ruleAccount = fetched.get(candidate.rule.toBase58());
        if (!ruleAccount?.owner.equals(LAUNCHPAD_PROGRAM)) return [];
        // Installed SDK layout.ts: discriminator, bump, version, platformId,
        // configId, epoch, eight u64 reserved fields, then the groups vector.
        // Runtime does not export that layout; do not infer parameter eligibility.
        const data = ruleAccount.data;
        if (
          data.length < 150 ||
          !new PublicKey(data.subarray(10, 42)).equals(platformId) ||
          !new PublicKey(data.subarray(42, 74)).equals(candidate.pubkey)
        )
          return [];
        const groups = data.readUInt32LE(146);
        let offset = 150;
        if (!groups || groups > Math.floor((data.length - offset) / 14))
          return [];
        for (let group = 0; group < groups; group++) {
          if (offset + 14 > data.length) return [];
          const constraints = data.readUInt32LE(offset + 10);
          offset += 14;
          if (constraints > Math.floor((data.length - offset) / 18)) return [];
          offset += constraints * 18;
        }
      }
      const mint = unpackMint(
        candidate.config.mintB,
        mintAccount,
        mintAccount.owner,
      );
      if (!mint.isInitialized) return [];
      return [
        {
          platformConfig: platformId.toBase58(),
          launchConfig: candidate.pubkey.toBase58(),
          quoteMint: candidate.config.mintB.toBase58(),
          quoteDecimals: mint.decimals,
          quoteTokenProgram: mintAccount.owner.toBase58(),
          curveType: candidate.config.curveType,
          configIndex: candidate.config.index,
          launchParametersRequireValidation: Boolean(
            platform.restrictCurveParam,
          ),
          curveRule: platform.restrictCurveParam
            ? candidate.rule.toBase58()
            : null,
        },
      ];
    })
    .sort((a, b) => a.launchConfig.localeCompare(b.launchConfig));
}
