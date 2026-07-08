import {
  assertWebAuth,
  errorResponse,
  jsonResponse,
  readJson,
} from "../../../src/web/http.js";
import {
  measureSolard,
  summarizeForMeasure,
} from "../../../src/solard/api-response.js";
import {
  addTokenToWatchGroup,
  createTokenWatchGroup,
  listTokenWatchGroups,
  removeTokenFromWatchGroup,
} from "../../../src/pump/services/pump-live-store.js";

export async function GET(request: Request): Promise<Response> {
  try {
    assertWebAuth(request);
    const measured = await measureSolard(
      "solard:api:GET:/api/watch-groups",
      "list",
      () => listTokenWatchGroups(),
      summarizeForMeasure,
    );
    return jsonResponse({
      ok: true,
      value: measured.value,
      meta: {
        route: "/api/watch-groups",
        method: "GET",
        scope: measured.scope,
        tookMs: measured.tookMs,
        summary: measured.summary,
      },
    });
  } catch (error) {
    return errorResponse(
      error,
      typeof (error as { status?: unknown }).status === "number"
        ? (error as { status: number }).status
        : 500,
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertWebAuth(request);
    const body = await readJson(request);
    const action = String(body.action ?? "");
    const measured = await measureSolard(
      `solard:api:POST:/api/watch-groups:${action || "unknown"}`,
      action || "unknown",
      () => {
        if (action === "create-group")
          return createTokenWatchGroup(String(body.name ?? ""));
        if (action === "add-token") {
          const token = (
            body.token && typeof body.token === "object" ? body.token : {}
          ) as Record<string, unknown>;
          return addTokenToWatchGroup({
            groupId: String(body.groupId ?? "main"),
            mint: String(token.mint ?? ""),
            name: typeof token.name === "string" ? token.name : null,
            symbol: typeof token.symbol === "string" ? token.symbol : null,
            creator: typeof token.creator === "string" ? token.creator : null,
            uri: typeof token.uri === "string" ? token.uri : null,
            image: typeof token.image === "string" ? token.image : null,
            signature:
              typeof token.signature === "string" ? token.signature : null,
            marketCapSol:
              token.marketCapSol == null || token.marketCapSol === ""
                ? null
                : Number(token.marketCapSol),
            isMayhemMode:
              typeof token.isMayhemMode === "boolean"
                ? token.isMayhemMode
                : null,
            quoteAsset:
              typeof token.quoteAsset === "string" ? token.quoteAsset : null,
            quoteMint:
              typeof token.quoteMint === "string" ? token.quoteMint : null,
            source: typeof token.source === "string" ? token.source : "manual",
          });
        }
        if (action === "remove-token")
          return removeTokenFromWatchGroup(
            String(body.groupId ?? ""),
            String(body.mint ?? ""),
          );
        throw new Error(`Unknown watch-groups action: ${action || "(empty)"}`);
      },
      summarizeForMeasure,
    );
    return jsonResponse({
      ok: true,
      value: measured.value,
      meta: {
        route: "/api/watch-groups",
        method: "POST",
        scope: measured.scope,
        tookMs: measured.tookMs,
        summary: measured.summary,
      },
    });
  } catch (error) {
    return errorResponse(
      error,
      typeof (error as { status?: unknown }).status === "number"
        ? (error as { status: number }).status
        : 500,
    );
  }
}
