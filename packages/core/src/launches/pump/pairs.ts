import {
  getTokenMetadata,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey, type AccountInfo, type Connection } from "@solana/web3.js";
import { Buffer } from "buffer";

import { globalPda } from "../../venues/pump/pda.ts";
import { PUMP_PROGRAM_ID } from "../../venues/pump/constants.ts";

const GLOBAL_WHITELIST_OFFSET = 1013;
const METAPLEX_TOKEN_METADATA_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
);
const ZERO_PUBLIC_KEY = new PublicKey(new Uint8Array(32)).toBase58();

export type PumpSupportedPair = {
  mint: string;
  symbol?: string;
  name?: string;
  quoteKind: "native-sol" | "spl-token";
  decimals: number;
  tokenProgram: string;
};

type PairMetadata = {
  symbol: string | null;
  name: string | null;
};

function clean(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\0/g, "").trim();
  return text || null;
}

function readBorshString(
  data: Buffer,
  offset: number,
): { value: string; next: number } {
  if (offset + 4 > data.length)
    throw new Error("metadata string length missing");
  const length = data.readUInt32LE(offset);
  const start = offset + 4;
  const end = start + length;
  if (end > data.length) throw new Error("metadata string truncated");
  return {
    value: data.subarray(start, end).toString("utf8").replace(/\0/g, "").trim(),
    next: end,
  };
}

function metaplexMetadataAddress(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("metadata"),
      METAPLEX_TOKEN_METADATA_PROGRAM_ID.toBuffer(),
      mint.toBuffer(),
    ],
    METAPLEX_TOKEN_METADATA_PROGRAM_ID,
  )[0];
}

function parseMetaplexMetadata(
  account: AccountInfo<Buffer> | null,
  mint: PublicKey,
): PairMetadata | null {
  if (!account || !account.owner.equals(METAPLEX_TOKEN_METADATA_PROGRAM_ID)) {
    return null;
  }
  const data = Buffer.from(account.data);
  if (data.length < 65) return null;
  const encodedMint = new PublicKey(data.subarray(33, 65));
  if (!encodedMint.equals(mint)) return null;
  try {
    let cursor = 65;
    const name = readBorshString(data, cursor);
    cursor = name.next;
    const symbol = readBorshString(data, cursor);
    return { name: clean(name.value), symbol: clean(symbol.value) };
  } catch {
    return null;
  }
}

function whitelistTail(data: Buffer): Buffer {
  if (data.length < GLOBAL_WHITELIST_OFFSET + 32) {
    throw new Error(
      `Pump Global account is ${data.length} bytes; expected at least ${GLOBAL_WHITELIST_OFFSET}.`,
    );
  }
  // Official Pump Global IDL: whitelisted_quote_mints is [pubkey; 1].
  // Creator-fee/holder-reward fields follow it; those bytes are not mints.
  return data.subarray(GLOBAL_WHITELIST_OFFSET, GLOBAL_WHITELIST_OFFSET + 32);
}

function decodeWhitelistedQuoteMints(data: Buffer): PublicKey[] {
  const tail = whitelistTail(data);
  let payload = tail;
  if (tail.length % 32 !== 0) {
    if (tail.length < 4 || (tail.length - 4) % 32 !== 0) {
      throw new Error(
        `Pump Global quote-mint whitelist has unsupported encoded length ${tail.length}.`,
      );
    }
    const count = tail.readUInt32LE(0);
    if (count !== (tail.length - 4) / 32) {
      throw new Error(
        `Pump Global quote-mint whitelist length prefix ${count} does not match account data.`,
      );
    }
    payload = tail.subarray(4);
  }

  const out: PublicKey[] = [];
  const seen = new Set<string>();
  for (let offset = 0; offset < payload.length; offset += 32) {
    const mint = new PublicKey(payload.subarray(offset, offset + 32));
    const value = mint.toBase58();
    if (value === ZERO_PUBLIC_KEY || value === NATIVE_MINT.toBase58()) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(mint);
  }
  return out;
}

async function multipleAccounts(
  connection: Connection,
  addresses: PublicKey[],
): Promise<Array<AccountInfo<Buffer> | null>> {
  const out: Array<AccountInfo<Buffer> | null> = [];
  for (let index = 0; index < addresses.length; index += 100) {
    out.push(
      ...(await connection.getMultipleAccountsInfo(
        addresses.slice(index, index + 100),
        "confirmed",
      )),
    );
  }
  return out;
}

async function token2022Metadata(
  connection: Connection,
  mint: PublicKey,
): Promise<PairMetadata | null> {
  try {
    const metadata = await getTokenMetadata(
      connection,
      mint,
      "confirmed",
      TOKEN_2022_PROGRAM_ID,
    );
    return metadata
      ? { name: clean(metadata.name), symbol: clean(metadata.symbol) }
      : null;
  } catch {
    return null;
  }
}

export async function getSupportedPumpPairs(
  connection: Connection,
): Promise<PumpSupportedPair[]> {
  const global = await connection.getAccountInfo(globalPda(), "confirmed");
  if (!global) throw new Error("Pump Global account was not found.");
  if (!global.owner.equals(PUMP_PROGRAM_ID) || !global.data.subarray(0, 8).equals(Buffer.from([167, 232, 232, 177, 200, 108, 114, 127]))) throw new Error("Invalid Pump Global account owner or discriminator");
  const quoteMints = decodeWhitelistedQuoteMints(Buffer.from(global.data));
  const result: PumpSupportedPair[] = [
    {
      mint: NATIVE_MINT.toBase58(),
      symbol: "SOL",
      name: "Solana",
      quoteKind: "native-sol",
      decimals: 9,
      tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    },
  ];
  if (!quoteMints.length) return result;

  const [mintAccounts, metadataAccounts] = await Promise.all([
    multipleAccounts(connection, quoteMints),
    multipleAccounts(connection, quoteMints.map(metaplexMetadataAddress)),
  ]);

  for (let index = 0; index < quoteMints.length; index += 1) {
    const mint = quoteMints[index]!;
    const account = mintAccounts[index];
    if (!account || account.data.length < 45) continue;
    const supportedProgram =
      account.owner.equals(TOKEN_PROGRAM_ID) ||
      account.owner.equals(TOKEN_2022_PROGRAM_ID);
    if (!supportedProgram) continue;

    let metadata = parseMetaplexMetadata(metadataAccounts[index] ?? null, mint);
    if (!metadata && account.owner.equals(TOKEN_2022_PROGRAM_ID)) {
      metadata = await token2022Metadata(connection, mint);
    }
    const value = mint.toBase58();
    if (value === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v") {
      metadata = {
        symbol: metadata?.symbol ?? "USDC",
        name: metadata?.name ?? "USD Coin",
      };
    }
    result.push({
      mint: value,
      ...(metadata?.symbol ? { symbol: metadata.symbol } : {}),
      ...(metadata?.name ? { name: metadata.name } : {}),
      quoteKind: "spl-token",
      decimals: account.data[44]!,
      tokenProgram: account.owner.toBase58(),
    });
  }

  const [sol, ...spl] = result;
  spl.sort((left, right) => {
    if (left.symbol === "USDC") return -1;
    if (right.symbol === "USDC") return 1;
    return (left.symbol ?? left.name ?? left.mint).localeCompare(
      right.symbol ?? right.name ?? right.mint,
    );
  });
  return sol ? [sol, ...spl] : spl;
}

export class PumpPairService {
  constructor(private readonly connection: () => Connection) {}

  async getSupportedPairs(): Promise<PumpSupportedPair[]> {
    return await getSupportedPumpPairs(this.connection());
  }
}
