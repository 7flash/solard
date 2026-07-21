import { readFileSync } from "node:fs";
import { basename } from "node:path";

export type MetadataUploaderId = "pump-frontend" | "pinata";

export type PumpCoinMetadataInput = {
  imagePath: string;
  name: string;
  symbol: string;
  description?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
  video?: string;
  showName?: boolean;
};

export type PumpCoinMetadataJson = {
  name: string;
  symbol: string;
  description: string;
  image: string;
  showName?: boolean;
  createdOn?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
  video?: string;
};

export type UploadedPumpCoinMetadata = {
  provider: MetadataUploaderId;
  metadataUri: string;
  imageUri?: string | null;
  json?: PumpCoinMetadataJson | Record<string, unknown>;
  raw?: unknown;
};

export type UploadPumpMetadataOptions = {
  provider?: MetadataUploaderId;
  endpoint?: string;
  fallback?: MetadataUploaderId | null;
  /** Per-request timeout in ms. Defaults to PUMP_METADATA_TIMEOUT_MS or 30s. */
  timeoutMs?: number;
};

const DEFAULT_UPLOAD_TIMEOUT_MS = 30_000;

function clean(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function uploadTimeoutMs(options: UploadPumpMetadataOptions): number {
  const fromOptions = options.timeoutMs;
  if (typeof fromOptions === "number" && Number.isFinite(fromOptions) && fromOptions > 0) {
    return Math.trunc(fromOptions);
  }
  const fromEnv = Number(
    process.env.PUMP_METADATA_TIMEOUT_MS ??
      process.env.SOLARD_PUMP_METADATA_TIMEOUT_MS ??
      "",
  );
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.trunc(fromEnv);
  return DEFAULT_UPLOAD_TIMEOUT_MS;
}

function fetchSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}

/** Pump frontend IPFS endpoint (documented as PUMP_IPFS_ENDPOINT). */
function pumpFrontendEndpoint(options: UploadPumpMetadataOptions): string {
  return (
    clean(options.endpoint) ||
    clean(process.env.PUMP_IPFS_ENDPOINT) ||
    clean(process.env.PUMP_METADATA_ENDPOINT) ||
    "https://pump.fun/api/ipfs"
  );
}

/** Pinata pin endpoint; does not reuse a Pump-frontend options.endpoint. */
function pinataEndpoint(options: UploadPumpMetadataOptions): string {
  return (
    clean(options.endpoint) ||
    clean(process.env.PINATA_API_URL) ||
    "https://api.pinata.cloud/pinning/pinFileToIPFS"
  );
}

function resolveProvider(
  options: UploadPumpMetadataOptions,
): MetadataUploaderId {
  const raw =
    options.provider ||
    clean(process.env.PUMP_METADATA_PROVIDER) ||
    clean(process.env.SLRD_METADATA_UPLOADER) ||
    clean(process.env.SOWL_METADATA_UPLOADER) ||
    "pump-frontend";
  return raw === "pinata" ? "pinata" : "pump-frontend";
}

function metadataJson(
  input: PumpCoinMetadataInput,
  imageUri: string,
): PumpCoinMetadataJson {
  return {
    name: input.name.trim(),
    symbol: input.symbol.trim(),
    description: clean(input.description) ?? `${input.name} (${input.symbol})`,
    image: imageUri,
    showName: input.showName !== false,
    createdOn: "https://pump.fun",
    ...(clean(input.twitter) ? { twitter: clean(input.twitter)! } : {}),
    ...(clean(input.telegram) ? { telegram: clean(input.telegram)! } : {}),
    ...(clean(input.website) ? { website: clean(input.website)! } : {}),
    ...(clean(input.video) ? { video: clean(input.video)! } : {}),
  };
}

function fileFromPath(path: string): File {
  const bytes = readFileSync(path);
  return new File([bytes], basename(path), {
    type: "application/octet-stream",
  });
}

function uriFromPayload(payload: any): string | null {
  const candidates = [
    payload?.metadataUri,
    payload?.metadata_uri,
    payload?.uri,
    payload?.jsonUri,
    payload?.json_uri,
    payload?.IpfsHash ? `ipfs://${payload.IpfsHash}` : null,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim())
      return candidate.trim();
  }
  return null;
}

export async function uploadPumpMetadataWithPumpFrontend(
  input: PumpCoinMetadataInput,
  options: UploadPumpMetadataOptions = {},
): Promise<UploadedPumpCoinMetadata> {
  const endpoint = pumpFrontendEndpoint(options);
  const timeoutMs = uploadTimeoutMs(options);

  const form = new FormData();
  form.set("file", fileFromPath(input.imagePath));
  form.set("name", input.name);
  form.set("symbol", input.symbol);
  form.set(
    "description",
    clean(input.description) ?? `${input.name} (${input.symbol})`,
  );
  if (clean(input.twitter)) form.set("twitter", clean(input.twitter)!);
  if (clean(input.telegram)) form.set("telegram", clean(input.telegram)!);
  if (clean(input.website)) form.set("website", clean(input.website)!);
  if (clean(input.video)) form.set("video", clean(input.video)!);
  form.set("showName", input.showName === false ? "false" : "true");

  const response = await fetch(endpoint, {
    method: "POST",
    body: form,
    signal: fetchSignal(timeoutMs),
  });
  const raw = await response.json().catch(async () => ({
    text: await response.text().catch(() => ""),
  }));
  if (!response.ok) {
    throw new Error(
      `Pump metadata upload failed (${response.status}): ${JSON.stringify(raw)}`,
    );
  }

  const metadataUri = uriFromPayload(raw);
  if (!metadataUri) {
    throw new Error(
      `Pump metadata upload did not return a metadata URI: ${JSON.stringify(raw)}`,
    );
  }

  return {
    provider: "pump-frontend",
    metadataUri,
    imageUri: typeof raw?.imageUri === "string" ? raw.imageUri : null,
    raw,
  };
}

export async function uploadPumpMetadataWithPinata(
  input: PumpCoinMetadataInput,
  options: UploadPumpMetadataOptions = {},
): Promise<UploadedPumpCoinMetadata> {
  const jwt = clean(process.env.PINATA_JWT);
  if (!jwt)
    throw new Error("PINATA_JWT is required for pinata metadata uploads.");

  const endpoint = pinataEndpoint(options);
  const timeoutMs = uploadTimeoutMs(options);

  const imageForm = new FormData();
  imageForm.set("file", fileFromPath(input.imagePath));
  const imageResponse = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${jwt}` },
    body: imageForm,
    signal: fetchSignal(timeoutMs),
  });
  const imageRaw = await imageResponse.json().catch(async () => ({
    text: await imageResponse.text().catch(() => ""),
  }));
  if (!imageResponse.ok || typeof imageRaw?.IpfsHash !== "string") {
    throw new Error(
      `Pinata image upload failed (${imageResponse.status}): ${JSON.stringify(imageRaw)}`,
    );
  }

  const imageUri = `ipfs://${imageRaw.IpfsHash}`;
  const json = metadataJson(input, imageUri);
  const jsonForm = new FormData();
  jsonForm.set(
    "file",
    new File(
      [JSON.stringify(json, null, 2)],
      `${input.symbol || "metadata"}.json`,
      {
        type: "application/json",
      },
    ),
  );
  const jsonResponse = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${jwt}` },
    body: jsonForm,
    signal: fetchSignal(timeoutMs),
  });
  const jsonRaw = await jsonResponse.json().catch(async () => ({
    text: await jsonResponse.text().catch(() => ""),
  }));
  if (!jsonResponse.ok || typeof jsonRaw?.IpfsHash !== "string") {
    throw new Error(
      `Pinata metadata upload failed (${jsonResponse.status}): ${JSON.stringify(jsonRaw)}`,
    );
  }

  return {
    provider: "pinata",
    metadataUri: `ipfs://${jsonRaw.IpfsHash}`,
    imageUri,
    json,
    raw: { image: imageRaw, metadata: jsonRaw },
  };
}

export async function uploadPumpMetadata(
  input: PumpCoinMetadataInput,
  options: UploadPumpMetadataOptions = {},
): Promise<UploadedPumpCoinMetadata> {
  const provider = resolveProvider(options);

  try {
    if (provider === "pinata")
      return await uploadPumpMetadataWithPinata(input, options);
    return await uploadPumpMetadataWithPumpFrontend(input, options);
  } catch (error) {
    if (options.fallback && options.fallback !== provider) {
      // Drop provider-specific endpoint so fallback uses its own defaults.
      const fallbackOptions: UploadPumpMetadataOptions = {
        ...options,
        provider: options.fallback,
        endpoint: undefined,
        fallback: null,
      };
      return options.fallback === "pinata"
        ? uploadPumpMetadataWithPinata(input, fallbackOptions)
        : uploadPumpMetadataWithPumpFrontend(input, fallbackOptions);
    }
    throw error;
  }
}
