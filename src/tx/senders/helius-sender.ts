import type { SowlSender } from "../sender.js";
import type { SenderId } from "../types.js";
import { MissingConfigError } from "../../core/errors.js";

function redactEndpoint(value: string): string {
  return value.replace(/([?&](?:api-key|apiKey)=)[^&]+/gi, "$1<redacted>");
}

export class HeliusSender implements SowlSender {
  constructor(private readonly endpoint = process.env.HELIUS_SENDER_URL, readonly id: SenderId = "helius") {}
  async send({ transaction }: Parameters<SowlSender["send"]>[0]): Promise<string> {
    if (!this.endpoint) throw new MissingConfigError("HELIUS_SENDER_URL");
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: String(Date.now()),
        method: "sendTransaction",
        params: [
          Buffer.from(transaction.serialize()).toString("base64"),
          { encoding: "base64", skipPreflight: true, maxRetries: 0 },
        ],
      }),
    });
    const raw = await response.text();
    let data: { result?: string; error?: { code?: number; message?: string; data?: unknown } };
    try { data = JSON.parse(raw) as typeof data; }
    catch { throw new Error(`Helius Sender ${redactEndpoint(this.endpoint)} returned HTTP ${response.status} non-JSON body: ${raw.slice(0, 500)}`); }
    if (!response.ok || data.error || !data.result) {
      const detail = data.error ? JSON.stringify(data.error) : raw.slice(0, 500);
      throw new Error(`Helius Sender ${redactEndpoint(this.endpoint)} failed HTTP ${response.status}: ${detail}`);
    }
    return data.result;
  }
}
