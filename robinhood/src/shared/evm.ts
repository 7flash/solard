import { keccak256, stringToHex } from "viem";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const TRANSFER_TOPIC = keccak256(
  stringToHex("Transfer(address,address,uint256)"),
);
export const UI_MULTIPLIER_UPDATED_TOPIC = keccak256(
  stringToHex("UIMultiplierUpdated(uint256,uint256,uint256)"),
);
export const TRANSFER_WITH_UI_TOPIC = keccak256(
  stringToHex("TransferWithUIAmount(address,address,uint256,uint256)"),
);

export function normalizeAddress(value: string): string {
  const address = value.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) {
    throw new Error(`invalid EVM address: ${value}`);
  }
  return address;
}

export function addressTopic(value: string): string {
  return `0x${normalizeAddress(value).slice(2).padStart(64, "0")}`;
}

export function topicAddress(value: string | undefined): string | null {
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) return null;
  return normalizeAddress(`0x${value.slice(-40)}`);
}

export function hexBigInt(value: string | undefined): bigint {
  if (!value || value === "0x") return 0n;
  if (!/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`invalid hex integer: ${value}`);
  }
  return BigInt(value);
}

export function decimalBigInt(
  value: string | number | bigint | undefined,
): bigint {
  if (value === undefined) return 0n;
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value))
      throw new Error(`unsafe integer: ${value}`);
    return BigInt(value);
  }
  return value.startsWith("0x") ? BigInt(value) : BigInt(value || "0");
}

export function formatUnitsExact(
  raw: bigint,
  decimals = 18,
  maxFraction = 8,
): string {
  const negative = raw < 0n;
  const value = negative ? -raw : raw;
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  let fraction = (value % scale).toString().padStart(decimals, "0");
  fraction = fraction.slice(0, Math.max(0, maxFraction)).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

export function scaledUiAmount(raw: bigint, multiplier: bigint): bigint {
  return (raw * multiplier) / 1_000_000_000_000_000_000n;
}

export interface TransferLogLike {
  address?: string;
  topics?: string[];
  data?: string;
  transactionHash?: string;
  transactionIndex?: number;
  logIndex?: number;
}

export interface Erc20Transfer {
  token: string;
  from: string;
  to: string;
  amount: bigint;
  transactionHash: string;
  transactionIndex: number;
  logIndex: number;
}

export function decodeTransfer(log: TransferLogLike): Erc20Transfer | null {
  const topics = log.topics ?? [];
  if (topics[0]?.toLowerCase() !== TRANSFER_TOPIC.toLowerCase()) return null;
  if (topics.length < 3 || !log.address || !log.transactionHash) return null;
  const from = topicAddress(topics[1]);
  const to = topicAddress(topics[2]);
  if (!from || !to) return null;
  return {
    token: normalizeAddress(log.address),
    from,
    to,
    amount: hexBigInt(log.data),
    transactionHash: log.transactionHash.toLowerCase(),
    transactionIndex: log.transactionIndex ?? 0,
    logIndex: log.logIndex ?? 0,
  };
}

export function shortAddress(value: string): string {
  return value.length < 13 ? value : `${value.slice(0, 6)}…${value.slice(-4)}`;
}
