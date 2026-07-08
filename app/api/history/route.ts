import { PublicKey } from "@solana/web3.js";
import {
  getTransactionsForAddress,
  resolvedHeliusRpcUrl,
} from "../../../src/chain/helius-history.js";
import {
  assertWebAuth,
  errorResponse,
  jsonResponse,
} from "../../../src/web/http.js";

function param(url: URL, name: string): string | null {
  const value = url.searchParams.get(name);
  return value && value.trim() ? value.trim() : null;
}

export async function GET(request: Request): Promise<Response> {
  try {
    assertWebAuth(request);
    const url = new URL(request.url);
    const address = param(url, "address");
    if (!address)
      throw Object.assign(new Error("Missing address"), { status: 400 });
    new PublicKey(address);
    const rpcUrl = resolvedHeliusRpcUrl();
    if (!rpcUrl)
      throw Object.assign(
        new Error(
          "Missing Helius RPC URL/API key for getTransactionsForAddress",
        ),
        { status: 400 },
      );

    const result = await getTransactionsForAddress({
      rpcUrl,
      address,
      limit: Number(param(url, "limit") ?? "100"),
      paginationToken: param(url, "paginationToken"),
      transactionDetails:
        param(url, "details") === "full" ? "full" : "signatures",
      sortOrder: param(url, "sort") === "asc" ? "asc" : "desc",
      commitment:
        param(url, "commitment") === "confirmed" ? "confirmed" : "finalized",
      status:
        (param(url, "status") as "succeeded" | "failed" | "any" | null) ??
        "succeeded",
      includeTokenAccounts: param(url, "includeTokenAccounts") !== "0",
      tokenMint: param(url, "mint"),
      direction:
        (param(url, "direction") as "in" | "out" | "any" | null) ?? "any",
    });
    return jsonResponse({ ok: true, value: result });
  } catch (error) {
    return errorResponse(
      error,
      typeof (error as { status?: unknown }).status === "number"
        ? (error as { status: number }).status
        : 500,
    );
  }
}
