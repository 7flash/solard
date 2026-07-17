import {
  assertWebAuth,
  errorResponse,
  jsonResponse,
  readJson,
  withSowl,
} from "../../../../src/web/http.js";
import {
  getAirdropJob,
  listAirdropJobs,
  requestAirdropCancel,
} from "../../../../src/solard/airdrops/job-store.js";
import { startAirdropJob } from "../../../../src/solard/airdrops/executor.js";
import {
  buildAirdropPlan,
  normalizeAirdropRules,
} from "../../../../src/solard/airdrops/planner.js";

function status(error: unknown): number {
  return typeof (error as { status?: unknown })?.status === "number"
    ? (error as { status: number }).status
    : 500;
}

export async function GET(request: Request): Promise<Response> {
  try {
    assertWebAuth(request);
    const url = new URL(request.url);
    const id = (url.searchParams.get("id") ?? "").trim();
    if (id) {
      const job = await getAirdropJob(id);
      if (!job) {
        return Response.json(
          { ok: false, error: "Airdrop job not found." },
          { status: 404 },
        );
      }
      return jsonResponse({ ok: true, value: job });
    }

    const limit = Math.max(
      1,
      Math.min(100, Number(url.searchParams.get("limit") ?? "20") || 20),
    );
    return jsonResponse({
      ok: true,
      value: await listAirdropJobs(limit),
    });
  } catch (error) {
    return errorResponse(error, status(error));
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await readJson(request)) as Record<string, unknown>;
    const action = String(
      body.action ?? (body.live === true ? "execute" : "preview"),
    ).toLowerCase();

    if (action === "cancel") {
      assertWebAuth(request);
      const id = String(body.id ?? "").trim();
      if (!id) {
        throw Object.assign(new Error("id is required."), { status: 400 });
      }
      return jsonResponse({
        ok: true,
        value: await requestAirdropCancel(id),
      });
    }

    return await withSowl(request, async (sowl) => {
      const rules = normalizeAirdropRules(body);
      const plan = await buildAirdropPlan(sowl.connection(), rules);

      if (action === "preview" || action === "validate") {
        return {
          status: "preview",
          plan,
        };
      }

      if (action !== "execute") {
        throw Object.assign(new Error(`Unknown airdrop action: ${action}`), {
          status: 400,
        });
      }

      if (body.confirmation !== "AIRDROP") {
        throw Object.assign(
          new Error('confirmation must equal "AIRDROP" for live execution.'),
          { status: 400 },
        );
      }

      const previewPlanId = String(body.previewPlanId ?? "").trim();
      if (!previewPlanId) {
        throw Object.assign(
          new Error("Preview the payout plan before live execution."),
          { status: 400 },
        );
      }
      if (previewPlanId !== plan.planId) {
        throw Object.assign(
          new Error(
            "The authoritative holder snapshot or payout rules changed after preview. Preview again before executing.",
          ),
          { status: 409 },
        );
      }

      const job = await startAirdropJob(plan);
      return {
        status: job.status,
        job,
      };
    });
  } catch (error) {
    return errorResponse(error, status(error));
  }
}
