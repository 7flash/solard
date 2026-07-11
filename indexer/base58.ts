const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58(bytes: Uint8Array): string {
  if (!bytes.length) return "";

  const digits = [0];

  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      const value = digits[i]! * 256 + carry;
      digits[i] = value % 58;
      carry = Math.floor(value / 58);
    }
    while (carry) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }

  let out = "";
  for (const byte of bytes) {
    if (byte === 0) out += "1";
    else break;
  }

  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]!];

  return out;
}
