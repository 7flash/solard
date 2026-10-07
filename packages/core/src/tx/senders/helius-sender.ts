import type { SolardSender } from "../sender.ts";
import type { SenderId } from "../types.ts";
import type { HeliusLandingTier } from "../helius-landing.ts";
import { solardRpcFetch } from "../../chain/connection.ts";

export function heliusSenderEndpoint(endpoint: string, tier: HeliusLandingTier): string {
  const url = new URL(endpoint);
  if (tier === "helius-swqos") url.searchParams.set("swqos_only", "true");
  else url.searchParams.delete("swqos_only");
  return url.toString();
}

function redactEndpoint(value: string): string {
  return value.replace(/([?&](?:api-key|apiKey)=)[^&]+/gi, "$1<redacted>");
}

export class HeliusSender implements SolardSender {
  constructor(
    private readonly endpoint = process.env.HELIUS_SENDER_URL ?? "https://sender.helius-rpc.com/fast",
    readonly id: SenderId = "helius",
    private readonly tier: HeliusLandingTier = id === "helius-swqos" ? "helius-swqos" : "helius-max",
  ) {}
  async send({
    transaction,
    options,
  }: Parameters<SolardSender["send"]>[0]): Promise<string> {
    const endpoint = heliusSenderEndpoint(this.endpoint, this.tier);
    const response = await solardRpcFetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: String(Date.now()),
        method: "sendTransaction",
        params: [
          Buffer.from(transaction.serialize()).toString("base64"),
          { encoding: "base64", skipPreflight: options?.skipPreflight ?? true, maxRetries: 0 },
        ],
      }),
    }, { retry429: false, retryNetwork: false });
    const raw = await response.text();
    let data: {
      result?: string;
      error?: { code?: number; message?: string; data?: unknown };
    };
    try {
      data = JSON.parse(raw) as typeof data;
    } catch {
      throw new Error(
        `Helius Sender ${redactEndpoint(this.endpoint)} returned HTTP ${response.status} non-JSON body: ${raw.slice(0, 500)}`,
      );
    }
    if (!response.ok || data.error || !data.result) {
      const detail = data.error
        ? JSON.stringify(data.error)
        : raw.slice(0, 500);
      throw new Error(
        `Helius Sender ${redactEndpoint(this.endpoint)} failed HTTP ${response.status}: ${detail}`,
      );
    }
    return data.result;
  }
}
