// Pump create / create_v2 decoding (no Portal deps)

export const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const CREATE_D8 = "0x181ec828051c0777";
export const CREATE_V2_D8 = "0xd6904cec5f8b31b4";

const CREATE_DISC = Uint8Array.from([
  0x18, 0x1e, 0xc8, 0x28, 0x05, 0x1c, 0x07, 0x77,
]);
const CREATE_V2_DISC = Uint8Array.from([
  0xd6, 0x90, 0x4c, 0xec, 0x5f, 0x8b, 0x31, 0xb4,
]);

export const CREATE_LAYOUT = {
  create: { mint: 0, bondingCurve: 2, user: 7, minAccounts: 14 },
  create_v2: { mint: 0, bondingCurve: 2, user: 5, minAccounts: 16 },
} as const;

export type CreateKind = keyof typeof CREATE_LAYOUT;

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_INDEX = new Map([...B58].map((c, i) => [c, i]));
const textDecoder = new TextDecoder();

export function base58Decode(value: string): Uint8Array {
  if (!value) return new Uint8Array();
  let leading = 0;
  while (leading < value.length && value[leading] === "1") leading++;
  const bytes: number[] = [];
  for (let i = leading; i < value.length; i++) {
    let carry = B58_INDEX.get(value[i]!) ?? -1;
    if (carry < 0) throw new Error("bad base58");
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j]! * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(leading + bytes.length);
  for (let i = 0; i < leading; i++) out[i] = 0;
  for (let i = 0; i < bytes.length; i++) out[out.length - 1 - i] = bytes[i]!;
  return out;
}

function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! << 8;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let s = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) s += B58[digits[i]!];
  return s;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function createKind(data: Uint8Array): CreateKind | null {
  if (data.length < 8) return null;
  const d = data.subarray(0, 8);
  if (equalBytes(d, CREATE_DISC)) return "create";
  if (equalBytes(d, CREATE_V2_DISC)) return "create_v2";
  return null;
}

class Reader {
  #o: number;
  #v: DataView;
  constructor(
    readonly data: Uint8Array,
    o = 0,
  ) {
    this.#o = o;
    this.#v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }
  get rem() {
    return this.data.length - this.#o;
  }
  bytes(n: number) {
    if (this.rem < n) throw new Error("underrun");
    const s = this.data.subarray(this.#o, this.#o + n);
    this.#o += n;
    return s;
  }
  u32() {
    if (this.rem < 4) throw new Error("underrun");
    const v = this.#v.getUint32(this.#o, true);
    this.#o += 4;
    return v;
  }
  string() {
    const len = this.u32();
    if (len > 1_000_000) throw new Error("bad string");
    return textDecoder.decode(this.bytes(len));
  }
  pubkey() {
    return base58Encode(this.bytes(32));
  }
  bool() {
    const v = this.bytes(1)[0]!;
    if (v !== 0 && v !== 1) throw new Error("bad bool");
    return v === 1;
  }
}

export interface DecodedCreate {
  kind: CreateKind;
  name: string;
  symbol: string;
  uri: string;
  creator?: string;
  isMayhemMode?: boolean;
}

export function decodeCreateArgs(data: Uint8Array): DecodedCreate | null {
  const kind = createKind(data);
  if (!kind) return null;
  try {
    const r = new Reader(data, 8);
    const name = r.string();
    const symbol = r.string();
    const uri = r.string();
    let creator: string | undefined;
    if (r.rem >= 32) creator = r.pubkey();
    let isMayhemMode: boolean | undefined;
    if (kind === "create_v2" && r.rem >= 1) isMayhemMode = r.bool();
    return { kind, name, symbol, uri, creator, isMayhemMode };
  } catch {
    return null;
  }
}
