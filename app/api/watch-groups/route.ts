import {
  assertWebAuth,
  errorResponse,
  jsonResponse,
  readJson,
} from "../../../src/web/http.js";
import {
  addTokenToWatchGroup,
  createTokenWatchGroup,
  listTokenWatchGroups,
  removeTokenFromWatchGroup,
} from "../../../src/web/token-watch-store.js";

export function GET(request: Request): Response {
  try {
    assertWebAuth(request);
    return jsonResponse({ ok: true, value: listTokenWatchGroups() });
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
    if (action === "create-group") {
      return jsonResponse({
        ok: true,
        value: createTokenWatchGroup(String(body.name ?? "")),
      });
    }
    if (action === "add-token") {
      const token = (
        body.token && typeof body.token === "object" ? body.token : {}
      ) as Record<string, unknown>;
      return jsonResponse({
        ok: true,
        value: addTokenToWatchGroup({
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
          source: typeof token.source === "string" ? token.source : "manual",
        }),
      });
    }
    if (action === "remove-token") {
      return jsonResponse({
        ok: true,
        value: removeTokenFromWatchGroup(
          String(body.groupId ?? ""),
          String(body.mint ?? ""),
        ),
      });
    }
    throw new Error(`Unknown watch-groups action: ${action || "(empty)"}`);
  } catch (error) {
    return errorResponse(
      error,
      typeof (error as { status?: unknown }).status === "number"
        ? (error as { status: number }).status
        : 500,
    );
  }
}
