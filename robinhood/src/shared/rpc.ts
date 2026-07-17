import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";
import { normalizeAddress } from "./evm.ts";
import { measure } from "./measure.ts";

const RPC_URL =
  process.env.RH_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const UI_ABI = parseAbi(["function uiMultiplier() view returns (uint256)"]);
let rpcId = 1;

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  return await measure(
    { start: () => `rpc.${method}`, end: () => ({ ok: true }), budget: 2_000 },
    async () => {
      const response = await fetch(RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
        signal: AbortSignal.timeout(
          Number(process.env.RH_RPC_TIMEOUT_MS ?? 15_000),
        ),
      });
      if (!response.ok) throw new Error(`${method} HTTP ${response.status}`);
      const body = (await response.json()) as {
        result?: T;
        error?: { message?: string };
      };
      if (body.error)
        throw new Error(body.error.message ?? JSON.stringify(body.error));
      if (body.result === undefined)
        throw new Error(`${method} returned no result`);
      return body.result;
    },
  );
}

export async function blockNumber(): Promise<number> {
  return Number(BigInt(await rpc<string>("eth_blockNumber", [])));
}

export async function uiMultiplier(
  token: string,
  block: number | "latest" = "latest",
): Promise<bigint> {
  const data = encodeFunctionData({
    abi: UI_ABI,
    functionName: "uiMultiplier",
  });
  const result = await rpc<`0x${string}`>("eth_call", [
    { to: normalizeAddress(token), data },
    block === "latest" ? "latest" : `0x${block.toString(16)}`,
  ]);
  return decodeFunctionResult({
    abi: UI_ABI,
    functionName: "uiMultiplier",
    data: result,
  });
}
