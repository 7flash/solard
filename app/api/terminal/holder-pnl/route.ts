import { listObservedHolderPositions } from "../../../../../shared/db.js";
import {
  apiMeasure,
  dbMeasure,
  summarizeError,
} from "../../../../../shared/measure.js";
import { assertWebAuth } from "../../../../../src/web/http.js";
import { errorResponse } from "../../../../_server/measure.js";

type HolderPnlBody = {
  mint?: unknown;
  owners?: unknown;
};

function cleanOwners(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return [
    ...new Set(value.map((item) => String(item).trim()).filter(Boolean)),
  ].slice(0, 100);
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertWebAuth(request);

    return await apiMeasure.measure(
      {
        start: () => "terminal.holder_pnl",

        end: (response: any) => ({
          status: Number(response?.status ?? 200),
        }),

        catch: summarizeError,
      },
      async () => {
        const body = (await request.json().catch(() => ({}))) as HolderPnlBody;

        const mint = String(body.mint ?? "").trim();

        const owners = cleanOwners(body.owners);

        if (!mint) {
          return Response.json(
            {
              ok: false,
              error: "mint is required",
            },
            {
              status: 400,
            },
          );
        }

        const positions = await dbMeasure.measure(
          {
            start: () => `db.holder_positions owners=${owners.length}`,

            end: (value: any) => ({
              positions: Array.isArray(value) ? value.length : 0,
            }),

            catch: summarizeError,
          },
          async () =>
            listObservedHolderPositions({
              mint,
              owners,
            }),
        );

        return Response.json({
          ok: true,
          mint,
          positions,

          basis: "observed-indexer-trades",

          limitations: [
            "does not include transfers",
            "does not include trades before tokenTradesV2",
          ],
        });
      },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
