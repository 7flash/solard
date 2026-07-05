import type { SowlSender } from "../sender.js";
export class RpcSender implements SowlSender {
  readonly id = "rpc";
  async send({ connection, transaction, options }: Parameters<SowlSender["send"]>[0]): Promise<string> {
    return await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: options?.skipPreflight ?? false, maxRetries: options?.skipPreflight ? 0 : 3 });
  }
}
