import type { SowlSender } from "../sender.js";
import type { SenderId } from "../types.js";
import { MissingConfigError } from "../../core/errors.js";

/** A named JSON-RPC sendTransaction endpoint, used for controlled route comparisons. */
export class HttpRpcSender implements SowlSender {
  constructor(
    readonly id: SenderId,
    private readonly endpoint?: string,
    private readonly configName = String(id),
  ) {}

  async send({ transaction, options }: Parameters<SowlSender["send"]>[0]): Promise<string> {
    if (!this.endpoint) throw new MissingConfigError(this.configName);
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: String(Date.now()),
        method: "sendTransaction",
        params: [
          Buffer.from(transaction.serialize()).toString("base64"),
          {
            encoding: "base64",
            skipPreflight: options?.skipPreflight ?? true,
            maxRetries: options?.skipPreflight ? 0 : 3,
          },
        ],
      }),
    });
    const raw = await response.text();
    let data: { result?: string; error?: { code?: number; message?: string; data?: unknown } };
    try { data = JSON.parse(raw) as typeof data; }
    catch { throw new Error(`${this.id} sendTransaction failed HTTP ${response.status}: ${raw.slice(0, 500)}`); }
    if (!response.ok || data.error || !data.result) {
      throw new Error(`${this.id} sendTransaction failed HTTP ${response.status}: ${data.error ? JSON.stringify(data.error) : raw.slice(0, 500)}`);
    }
    return data.result;
  }
}
