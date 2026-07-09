import {
  redactRpcUrl,
  resolvedHeliusRpcUrl,
  rpcHasApiKey,
} from "../../../src/chain/helius-history.js";
import { jsonResponse, withSowl } from "../../../src/web/http.js";
import { terminalHealthAction } from "../../../src/solard/actions/terminal-health.js";

export async function GET(request: Request): Promise<Response> {
  const startedAt = Date.now();
  try {
    return await withSowl(request, async (sowl) => {
      const connection = sowl.connection();
      let ok = false;
      let error: string | null = null;
      let slot: number | null = null;
      let blockhash: string | null = null;
      let version: unknown = null;

      try {
        const [slotResult, blockhashResult, versionResult] = await Promise.all([
          connection.getSlot("confirmed"),
          connection.getLatestBlockhash("confirmed"),
          connection.getVersion().catch(() => null),
        ]);
        ok = true;
        slot = slotResult;
        blockhash = blockhashResult.blockhash;
        version = versionResult;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }

      const rpcUrl =
        (connection as { rpcEndpoint?: string }).rpcEndpoint ??
        resolvedHeliusRpcUrl();
      const wsUrl =
        process.env.SOLWAL_HELIUS_WS_URL?.trim() ||
        (process.env.HELIUS_API_KEY?.trim()
          ? `wss://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY.trim()}`
          : null);

      return {
        ok,
        error,
        latencyMs: Date.now() - startedAt,
        slot,
        blockhash,
        version,
        terminal: terminalHealthAction({ errors: 5 }),
        rpc: {
          url: redactRpcUrl(rpcUrl),
          hasApiKey: rpcHasApiKey(rpcUrl),
          source: process.env.HELIUS_RPC_URL?.trim()
            ? "HELIUS_RPC_URL"
            : process.env.RPC_ENDPOINT?.trim()
              ? "RPC_ENDPOINT"
              : process.env.HELIUS_API_KEY?.trim()
                ? "HELIUS_API_KEY"
                : "unknown",
        },
        websocket: { url: redactRpcUrl(wsUrl), hasApiKey: rpcHasApiKey(wsUrl) },
        sender: {
          heliusSenderUrl: redactRpcUrl(
            process.env.HELIUS_SENDER_URL?.trim() || null,
          ),
          heliusTipAccount:
            process.env.HELIUS_TIP_ACCOUNT?.trim() ||
            process.env.SOLWAL_HELIUS_TIP_ACCOUNT?.trim() ||
            process.env.SOWL_HELIUS_TIP_ACCOUNT?.trim() ||
            null,
        },
      };
    });
  } catch (error) {
    return jsonResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      latencyMs: Date.now() - startedAt,
      terminal: terminalHealthAction({ errors: 5 }),
      rpc: {
        url: redactRpcUrl(resolvedHeliusRpcUrl()),
        hasApiKey: rpcHasApiKey(resolvedHeliusRpcUrl()),
        source: process.env.HELIUS_RPC_URL?.trim()
          ? "HELIUS_RPC_URL"
          : process.env.RPC_ENDPOINT?.trim()
            ? "RPC_ENDPOINT"
            : process.env.HELIUS_API_KEY?.trim()
              ? "HELIUS_API_KEY"
              : "unknown",
      },
    });
  }
}
