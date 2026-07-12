const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const INDEX = new Map(
  [...ALPHABET].map((character, index) => [character, index]),
);

export function decodeBase58(value: string): Uint8Array {
  if (!value) {
    return new Uint8Array();
  }

  const bytes = [0];

  for (const character of value) {
    const digit = INDEX.get(character);

    if (digit == null) {
      throw new Error(`Invalid base58 character ${character}`);
    }

    let carry = digit;

    for (let index = 0; index < bytes.length; index++) {
      const current = bytes[index] * 58 + carry;

      bytes[index] = current & 0xff;

      carry = current >> 8;
    }

    while (carry > 0) {
      bytes.push(carry & 0xff);

      carry >>= 8;
    }
  }

  for (
    let index = 0;
    index < value.length - 1 && value[index] === "1";
    index++
  ) {
    bytes.push(0);
  }

  return Uint8Array.from(bytes.reverse());
}

export function encodeBase58(bytes: Uint8Array): string {
  if (!bytes.length) {
    return "";
  }

  const digits = [0];

  for (const byte of bytes) {
    let carry = byte;

    for (let index = 0; index < digits.length; index++) {
      const value = digits[index] * 256 + carry;

      digits[index] = value % 58;

      carry = Math.floor(value / 58);
    }

    while (carry) {
      digits.push(carry % 58);

      carry = Math.floor(carry / 58);
    }
  }

  let output = "";

  for (const byte of bytes) {
    if (byte === 0) {
      output += "1";
    } else {
      break;
    }
  }

  for (let index = digits.length - 1; index >= 0; index--) {
    output += ALPHABET[digits[index]];
  }

  return output;
}
