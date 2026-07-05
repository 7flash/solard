import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { PinataSDK } from "pinata";
import { measure } from "../core/log.js";
import { measured } from "../core/measured.js";

const m = measure("metadata");
const DEFAULT_PUMP_FRONTEND_ENDPOINT = "https://pump.fun/api/ipfs";
const DEFAULT_PUBLIC_GATEWAY = "https://ipfs.io/ipfs";
const DEFAULT_MAX_IMAGE_BYTES = 5_000_000;

export type MetadataUploaderId = "pump-frontend" | "pinata";
export type PumpCoinMetadataInput = {
  imagePath: string;
  name: string;
  symbol: string;
  description: string;
  showName?: boolean;
  createdOn?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
  video?: string;
};

export type PumpCoinMetadataJson = {
  name: string;
  symbol: string;
  description: string;
  image?: string;
  showName: boolean;
  createdOn?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
  video?: string;
};

export type UploadedPumpCoinMetadata = {
  provider: MetadataUploaderId;
  imagePath: string;
  imageCid?: string;
  imageUri?: string;
  metadataCid?: string;
  metadataUri: string;
  metadata: PumpCoinMetadataJson;
  endpoint?: string;
};

export type UploadPumpMetadataOptions = {
  provider?: MetadataUploaderId;
  endpoint?: string;
  /** Explicit fallback only; uploads must never silently change provider. */
  fallback?: "pinata" | null;
};

function requiredEnv(name: string, description: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}. ${description}`);
  return value;
}
function contentType(imagePath: string): string {
  switch (extname(imagePath).toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".svg": return "image/svg+xml";
    default: throw new Error(`Unsupported image extension for Pump metadata: ${extname(imagePath) || "(none)"}`);
  }
}
function ipfsUri(cid: string): string {
  const gateway = (process.env.IPFS_PUBLIC_GATEWAY ?? DEFAULT_PUBLIC_GATEWAY).replace(/\/$/, "");
  return `${gateway}/${cid}`;
}
function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
function validateInput(input: PumpCoinMetadataInput): { imagePath: string; bytes: Uint8Array; mime: string } {
  const imagePath = resolve(input.imagePath);
  if (!existsSync(imagePath)) throw new Error(`Metadata image file not found: ${imagePath}`);
  if (!input.name.trim()) throw new Error("Metadata name cannot be empty");
  if (!input.symbol.trim()) throw new Error("Metadata symbol cannot be empty");
  if (!input.description.trim()) throw new Error(`Metadata description cannot be empty for $${input.symbol}`);
  const stat = statSync(imagePath);
  const maxBytes = Number(process.env.SOWL_MAX_IMAGE_BYTES ?? process.env.PINATA_MAX_IMAGE_BYTES ?? DEFAULT_MAX_IMAGE_BYTES);
  if (stat.size > maxBytes) throw new Error(`Metadata image is too large: ${stat.size} bytes exceeds ${maxBytes}`);
  return { imagePath, bytes: new Uint8Array(readFileSync(imagePath)), mime: contentType(imagePath) };
}
function blobPart(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
function baseMetadata(input: PumpCoinMetadataInput): PumpCoinMetadataJson {
  return {
    name: input.name,
    symbol: input.symbol,
    description: input.description,
    showName: input.showName ?? true,
    ...(optional(input.createdOn) ? { createdOn: optional(input.createdOn)! } : {}),
    ...(optional(input.twitter) ? { twitter: optional(input.twitter)! } : {}),
    ...(optional(input.telegram) ? { telegram: optional(input.telegram)! } : {}),
    ...(optional(input.website) ? { website: optional(input.website)! } : {}),
    ...(optional(input.video) ? { video: optional(input.video)! } : {}),
  };
}
function resultLog(uploaded: UploadedPumpCoinMetadata) {
  return { provider: uploaded.provider, symbol: uploaded.metadata.symbol, metadataUri: uploaded.metadataUri, endpoint: uploaded.endpoint };
}

/**
 * Uses the same browser-facing upload shape commonly used by the Pump frontend:
 * multipart form-data with `file`, name/symbol/description/social fields, returning
 * `metadataUri`. This endpoint is a hosted frontend service, not an on-chain API;
 * use `sowl metadata upload` to verify it immediately before a production launch.
 */
export async function uploadPumpMetadataWithPumpFrontend(
  input: PumpCoinMetadataInput,
  options: { endpoint?: string } = {},
): Promise<UploadedPumpCoinMetadata> {
  return await measured(m, `pump-frontend $${input.symbol}`, async () => {
    const { imagePath, bytes, mime } = validateInput(input);
    const endpoint = options.endpoint ?? process.env.PUMP_IPFS_ENDPOINT?.trim() ?? DEFAULT_PUMP_FRONTEND_ENDPOINT;
    const form = new FormData();
    form.append("file", new Blob([blobPart(bytes)], { type: mime }), basename(imagePath));
    form.append("name", input.name);
    form.append("symbol", input.symbol);
    form.append("description", input.description);
    form.append("showName", String(input.showName ?? true));
    for (const field of ["twitter", "telegram", "website", "video"] as const) {
      const value = optional(input[field]);
      if (value) form.append(field, value);
    }
    const response = await fetch(endpoint, { method: "POST", body: form });
    const body = await response.text();
    if (!response.ok) throw new Error(`Pump frontend metadata upload failed (${response.status}): ${body.slice(0, 300)}`);
    let data: { metadataUri?: unknown; metadata?: PumpCoinMetadataJson; imageUri?: string };
    try { data = JSON.parse(body) as typeof data; }
    catch { throw new Error(`Pump frontend metadata upload returned non-JSON: ${body.slice(0, 300)}`); }
    if (typeof data.metadataUri !== "string" || !data.metadataUri.trim()) {
      throw new Error(`Pump frontend metadata upload returned no metadataUri: ${body.slice(0, 300)}`);
    }
    return {
      provider: "pump-frontend" as const,
      endpoint,
      imagePath,
      metadataUri: data.metadataUri,
      imageUri: data.imageUri,
      metadata: data.metadata ?? baseMetadata(input),
    };
  }, resultLog);
}

/** Pinata remains an explicit fallback; it is never selected silently. */
export async function uploadPumpMetadataWithPinata(input: PumpCoinMetadataInput): Promise<UploadedPumpCoinMetadata> {
  return await measured(m, `pinata $${input.symbol}`, async () => {
    const { imagePath, bytes, mime } = validateInput(input);
    const jwt = requiredEnv("PINATA_JWT", "Create a Pinata JWT and set it before using --provider pinata.");
    const pinata = new PinataSDK({
      pinataJwt: jwt,
      ...(process.env.PINATA_GATEWAY_DOMAIN ? { pinataGateway: process.env.PINATA_GATEWAY_DOMAIN } : {}),
    });
    const imageFile = new File([blobPart(bytes)], basename(imagePath), { type: mime });
    const imageUpload = await pinata.upload.public.file(imageFile).name(`${input.symbol}-image-${basename(imagePath)}`);
    const imageUri = ipfsUri(imageUpload.cid);
    const metadata: PumpCoinMetadataJson = { ...baseMetadata(input), image: imageUri, createdOn: input.createdOn ?? "https://pump.fun" };
    const metadataUpload = await pinata.upload.public.json(metadata).name(`${input.symbol}-metadata.json`);
    return {
      provider: "pinata" as const,
      imagePath,
      imageCid: imageUpload.cid,
      imageUri,
      metadataCid: metadataUpload.cid,
      metadataUri: ipfsUri(metadataUpload.cid),
      metadata,
    };
  }, resultLog);
}

export async function uploadPumpMetadata(
  input: PumpCoinMetadataInput,
  options: UploadPumpMetadataOptions = {},
): Promise<UploadedPumpCoinMetadata> {
  const provider = options.provider ?? (process.env.SOWL_METADATA_UPLOADER as MetadataUploaderId | undefined) ?? "pump-frontend";
  if (provider === "pinata") return await uploadPumpMetadataWithPinata(input);
  try {
    return await uploadPumpMetadataWithPumpFrontend(input, { endpoint: options.endpoint });
  } catch (error) {
    const fallback = options.fallback ?? (process.env.SOWL_METADATA_FALLBACK === "pinata" ? "pinata" : null);
    if (fallback !== "pinata") throw error;
    return await uploadPumpMetadataWithPinata(input);
  }
}
