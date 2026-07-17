import { normalizeAddress } from "./evm.ts";

export interface KnownToken {
  symbol: string;
  address: string;
  kind: "gas-wrapper" | "stablecoin" | "stock" | "etf";
  decimals: number;
  scaledUi: boolean;
}

const definitions: KnownToken[] = [
  {
    symbol: "WETH",
    address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    kind: "gas-wrapper",
    decimals: 18,
    scaledUi: false,
  },
  {
    symbol: "USDG",
    address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    kind: "stablecoin",
    decimals: 6,
    scaledUi: false,
  },
  {
    symbol: "AAPL",
    address: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9",
    kind: "stock",
    decimals: 18,
    scaledUi: true,
  },
  {
    symbol: "AMD",
    address: "0x86923f96303D656E4aa86D9d42D1e57ad2023fdC",
    kind: "stock",
    decimals: 18,
    scaledUi: true,
  },
  {
    symbol: "AMZN",
    address: "0x12f190a9F9d7D37a250758b26824B97CE941bF54",
    kind: "stock",
    decimals: 18,
    scaledUi: true,
  },
  {
    symbol: "BABA",
    address: "0xad25Ac6C84D497db898fa1E8387bf6Af3532a1c4",
    kind: "stock",
    decimals: 18,
    scaledUi: true,
  },
  {
    symbol: "BE",
    address: "0x822CC93fFD030293E9842c30BBD678F530701867",
    kind: "stock",
    decimals: 18,
    scaledUi: true,
  },
  {
    symbol: "COIN",
    address: "0x6330D8C3178a418788dF01a47479c0ce7CCF450b",
    kind: "stock",
    decimals: 18,
    scaledUi: true,
  },
  {
    symbol: "CRCL",
    address: "0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5",
    kind: "stock",
    decimals: 18,
    scaledUi: true,
  },
  {
    symbol: "CRWV",
    address: "0x5f10A1C971B69e47e059e1dC91901B59b3fB49C3",
    kind: "stock",
    decimals: 18,
    scaledUi: true,
  },
  {
    symbol: "GOOGL",
    address: "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3",
    kind: "stock",
    decimals: 18,
    scaledUi: true,
  },
  {
    symbol: "INTC",
    address: "0xc72b96e0E48ecd4DC75E1e45396e26300BC39681",
    kind: "stock",
    decimals: 18,
    scaledUi: true,
  },
  {
    symbol: "META",
    address: "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35",
    kind: "stock",
    decimals: 18,
    scaledUi: true,
  },
  {
    symbol: "MSFT",
    address: "0xe93237C50D904957Cf27E7B1133b510C669c2e74",
    kind: "stock",
    decimals: 18,
    scaledUi: true,
  },
  {
    symbol: "MU",
    address: "0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD",
    kind: "stock",
    decimals: 18,
    scaledUi: true,
  },
  {
    symbol: "NVDA",
    address: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
    kind: "stock",
    decimals: 18,
    scaledUi: true,
  },
  {
    symbol: "ORCL",
    address: "0xb0992820E760d836549ba69BC7598b4af75dEE03",
    kind: "stock",
    decimals: 18,
    scaledUi: true,
  },
  {
    symbol: "PLTR",
    address: "0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A",
    kind: "stock",
    decimals: 18,
    scaledUi: true,
  },
  {
    symbol: "SNDK",
    address: "0xB90A19fF0Af67f7779afF50A882A9CfF42446400",
    kind: "stock",
    decimals: 18,
    scaledUi: true,
  },
  {
    symbol: "SPCX",
    address: "0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa",
    kind: "stock",
    decimals: 18,
    scaledUi: true,
  },
  {
    symbol: "TSLA",
    address: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d",
    kind: "stock",
    decimals: 18,
    scaledUi: true,
  },
  {
    symbol: "USAR",
    address: "0xd917B029C761D264c6A312BBbcDA868658eF86a6",
    kind: "stock",
    decimals: 18,
    scaledUi: true,
  },
  {
    symbol: "QQQ",
    address: "0xD5f3879160bc7c32ebb4dC785F8a4F505888de68",
    kind: "etf",
    decimals: 18,
    scaledUi: true,
  },
  {
    symbol: "SGOV",
    address: "0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5",
    kind: "etf",
    decimals: 18,
    scaledUi: true,
  },
  {
    symbol: "SLV",
    address: "0x411eFb0E7f985935DAec3D4C3ebaEa0d0AD7D89f",
    kind: "etf",
    decimals: 18,
    scaledUi: true,
  },
  {
    symbol: "SPY",
    address: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C",
    kind: "etf",
    decimals: 18,
    scaledUi: true,
  },
  {
    symbol: "CUSO",
    address: "0xa30FA36Db767ad9eD3f7a60fC79526fB4d56D344",
    kind: "etf",
    decimals: 18,
    scaledUi: true,
  },
];

export const KNOWN_TOKENS = definitions.map((token) => ({
  ...token,
  address: normalizeAddress(token.address),
}));
export const TOKEN_BY_ADDRESS = new Map(
  KNOWN_TOKENS.map((token) => [token.address, token]),
);
export const TOKEN_BY_SYMBOL = new Map(
  KNOWN_TOKENS.map((token) => [token.symbol, token]),
);

export function resolveTokens(
  args: string[],
  canonicalDefault = false,
): KnownToken[] {
  const canonical =
    args.includes("--canonical") || (canonicalDefault && args.length === 0);
  const values = args.filter((arg) => !arg.startsWith("--"));
  if (canonical)
    return KNOWN_TOKENS.filter(
      (token) => token.kind === "stock" || token.kind === "etf",
    );
  const result: KnownToken[] = [];
  for (const value of values) {
    const known =
      TOKEN_BY_SYMBOL.get(value.toUpperCase()) ??
      TOKEN_BY_ADDRESS.get(normalizeAddress(value));
    result.push(
      known ?? {
        symbol: value.slice(0, 8),
        address: normalizeAddress(value),
        kind: "stock",
        decimals: 18,
        scaledUi: false,
      },
    );
  }
  return result;
}
