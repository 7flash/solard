import bs58 from "bs58";
import type { VersionedTransaction } from "@solana/web3.js";
import type { SowlBundleSender } from "../sender.js";
import { MissingConfigError } from "../../core/errors.js";

function transactionSignature(transaction: VersionedTransaction): string {
  const signature = transaction.signatures[0];
  if (!signature) throw new Error("Signed transaction is missing its payer signature");
  return bs58.encode(signature);
}

export class JitoSender implements SowlBundleSender {
  readonly id = "jito";
  constructor(private readonly endpoint = process.env.JITO_BLOCK_ENGINE_URL) {}

  async send({ connection, transaction }: Parameters<SowlBundleSender["send"]>[0]): Promise<string> {
    await this.sendBundle({ connection, transactions: [transaction] });
    return transactionSignature(transaction);
  }

  async sendBundle({ transactions }: Parameters<SowlBundleSender["sendBundle"]>[0]) {
    if (!this.endpoint) throw new MissingConfigError("JITO_BLOCK_ENGINE_URL");
    if (transactions.length === 0 || transactions.length > 5) throw new Error(`Jito bundle requires 1..5 transactions, got ${transactions.length}`);
    const url = `${this.endpoint.replace(/\/$/, "")}/api/v1/bundles`;
    const serialized = transactions.map((transaction) => Buffer.from(transaction.serialize()).toString("base64"));
    const response = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "sendBundle", params: [serialized, { encoding: "base64" }] }),
    });
    const data = await response.json() as { result?: string; error?: unknown };
    if (!response.ok || data.error || !data.result) throw new Error(`Jito bundle submission failed: ${JSON.stringify(data.error ?? response.status)}`);
    return { submissionId: data.result, signatures: transactions.map(transactionSignature) };
  }
}
