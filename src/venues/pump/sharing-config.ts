import { PublicKey, type Connection } from "@solana/web3.js";
import { sharingConfigPda } from "./pda.js";

const SHARING_CONFIG_DISCRIMINATOR = Buffer.from([
  216, 74, 9, 0, 56, 140, 93, 75,
]);
const HEADER_LENGTH = 8 + 1 + 1 + 1 + 32 + 32 + 1 + 4;

export type PumpShareholder = { address: PublicKey; shareBps: number };
export type PumpSharingConfig = {
  address: PublicKey;
  bump: number;
  version: number;
  status: number;
  mint: PublicKey;
  admin: PublicKey;
  adminRevoked: boolean;
  shareholders: PumpShareholder[];
};

/** Decode only the official Pump Fees SharingConfig Borsh account needed for distribution. */
export function decodeSharingConfig(
  address: PublicKey,
  raw: Buffer,
): PumpSharingConfig {
  if (raw.length < HEADER_LENGTH)
    throw new Error(
      `Sharing config account ${address.toBase58()} is too short`,
    );
  if (!raw.subarray(0, 8).equals(SHARING_CONFIG_DISCRIMINATOR)) {
    throw new Error(
      `Account ${address.toBase58()} is not a Pump Fees sharing_config`,
    );
  }
  let offset = 8;
  const bump = raw.readUInt8(offset++);
  const version = raw.readUInt8(offset++);
  const status = raw.readUInt8(offset++);
  const mint = new PublicKey(raw.subarray(offset, offset + 32));
  offset += 32;
  const admin = new PublicKey(raw.subarray(offset, offset + 32));
  offset += 32;
  const adminRevoked = raw.readUInt8(offset++) !== 0;
  const count = raw.readUInt32LE(offset);
  offset += 4;
  if (count < 1 || count > 10)
    throw new Error(`Invalid Pump sharing_config shareholder count: ${count}`);
  const required = offset + count * 34;
  if (raw.length < required)
    throw new Error(
      `Sharing config ${address.toBase58()} is truncated for ${count} shareholders`,
    );
  const shareholders: PumpShareholder[] = [];
  let totalBps = 0;
  for (let index = 0; index < count; index += 1) {
    const shareholder = new PublicKey(raw.subarray(offset, offset + 32));
    offset += 32;
    const shareBps = raw.readUInt16LE(offset);
    offset += 2;
    shareholders.push({ address: shareholder, shareBps });
    totalBps += shareBps;
  }
  if (totalBps !== 10_000)
    throw new Error(`Invalid Pump sharing_config total share bps: ${totalBps}`);
  return {
    address,
    bump,
    version,
    status,
    mint,
    admin,
    adminRevoked,
    shareholders,
  };
}

export async function fetchSharingConfig(
  connection: Connection,
  mint: PublicKey,
): Promise<PumpSharingConfig | null> {
  const address = sharingConfigPda(mint);
  const info = await connection.getAccountInfo(address, "confirmed");
  if (!info) return null;
  const config = decodeSharingConfig(address, Buffer.from(info.data));
  if (!config.mint.equals(mint))
    throw new Error(`Sharing config mint mismatch for ${mint.toBase58()}`);
  return config;
}
