import type { SolardSender } from "../sender.ts";
export class RpcSender implements SolardSender {
  readonly id = "rpc";
  async send({
    connection,
    transaction,
    options,
  }: Parameters<SolardSender["send"]>[0]): Promise<string> {
    return await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: options?.skipPreflight ?? false,
      maxRetries: options?.skipPreflight ? 0 : 3,
    });
  }
}
