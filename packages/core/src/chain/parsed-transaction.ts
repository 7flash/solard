import { Connection, type ParsedTransactionWithMeta, type GetVersionedTransactionConfig } from "@solana/web3.js";

export type CompatibleParsedTransaction = Omit<ParsedTransactionWithMeta, "version"> & {
  version?: "legacy" | 0 | 1;
};

/** Validate the complete jsonParsed response with web3's existing schema, and
 * validate the extended version discriminator separately. Never relabel v1. */
export async function getCompatibleParsedTransaction(
  connection: Connection,
  signature: string,
  config: GetVersionedTransactionConfig = { commitment: "confirmed", maxSupportedTransactionVersion: 1 },
): Promise<CompatibleParsedTransaction | null> {
  // Mock/custom transports without a raw RPC hook retain their own contract.
  if (!("_rpcRequest" in connection)) return await connection.getParsedTransaction(signature, config);
  let version: CompatibleParsedTransaction["version"];
  const transport = new Proxy(connection, {
    get(target, property, receiver) {
      if (property !== "_rpcRequest") return Reflect.get(target, property, receiver);
      return async (method: string, args: unknown[]) => {
        const response: unknown = await (target as Connection & {
          _rpcRequest(method: string, args: unknown[]): Promise<unknown>;
        })._rpcRequest(method, args);
        if (typeof response !== "object" || response == null || !("result" in response)) return response;
        const result = response.result;
        if (typeof result !== "object" || result == null) return response;
        const rawVersion = "version" in result ? result.version : undefined;
        if (rawVersion !== undefined && rawVersion !== "legacy" && rawVersion !== 0 && rawVersion !== 1)
          throw new Error(`Unsupported parsed transaction version: ${String(rawVersion)}`);
        version = rawVersion;
        const { version: omitted, ...body } = result as Record<string, unknown>;
        return { ...response, result: body };
      };
    },
  });
  const parsed = await connection.getParsedTransaction.call(transport, signature, config);
  return parsed == null ? null : { ...parsed, ...(version === undefined ? {} : { version }) };
}
