import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { MissingConfigError } from "./errors.js";
export function parseKeypair(raw: string): Keypair {
  const source = raw.trim();
  if (!source) throw new Error("Empty private key");
  if (source.startsWith("[")) {
    const bytes = JSON.parse(source) as unknown;
    if (
      !Array.isArray(bytes) ||
      bytes.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
    ) {
      throw new Error("JSON private key must be an array of bytes");
    }
    return Keypair.fromSecretKey(Uint8Array.from(bytes));
  }
  return Keypair.fromSecretKey(bs58.decode(source));
}
function masterKey(): Buffer {
  const source = process.env.SOWL_MASTER_KEY;
  if (!source)
    throw new MissingConfigError(
      "SOWL_MASTER_KEY (required for importing or signing with persisted wallets)",
    );
  return createHash("sha256").update(source).digest();
}
export type EncryptedSecret = {
  encryptedSecretKey: string;
  nonce: string;
  authTag: string;
};
export function encryptKeypair(keypair: Keypair): EncryptedSecret {
  const nonce = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", masterKey(), nonce);
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(keypair.secretKey)),
    cipher.final(),
  ]);
  return {
    encryptedSecretKey: encrypted.toString("base64"),
    nonce: nonce.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}
export function decryptKeypair(secret: EncryptedSecret): Keypair {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    masterKey(),
    Buffer.from(secret.nonce, "base64"),
  );
  decipher.setAuthTag(Buffer.from(secret.authTag, "base64"));
  return Keypair.fromSecretKey(
    Buffer.concat([
      decipher.update(Buffer.from(secret.encryptedSecretKey, "base64")),
      decipher.final(),
    ]),
  );
}
