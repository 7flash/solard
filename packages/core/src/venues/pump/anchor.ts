import { createHash } from "node:crypto";
export function anchorDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}
export function u64(value: bigint): Buffer {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn)
    throw new Error(`Invalid u64: ${value}`);
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(value);
  return out;
}
/** Pump OptionBool is an Anchor tuple struct containing one bool: [false] or [true].
 * It is NOT Rust Option<bool>; prepending a presence byte enables the flag. */
export function optionBool(value: boolean): Buffer {
  return Buffer.from([value ? 1 : 0]);
}

export function bool(value: boolean): Buffer {
  return Buffer.from([value ? 1 : 0]);
}
export function string(value: string): Buffer {
  const encoded = Buffer.from(value, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32LE(encoded.length);
  return Buffer.concat([length, encoded]);
}
