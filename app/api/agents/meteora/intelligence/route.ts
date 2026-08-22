import {
  readJson,
  requireString,
  withSolard,
} from "../../../../../src/web/http.js";

function argsObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Meteora intelligence/model-policy bridge.
 *
 * GET  /api/agents/meteora/intelligence?agent=<name>
 * POST /api/agents/meteora/intelligence
 *   { "agent": "lp-agent", "tool": "meteora_intelligence_context", "args": {} }
 *
 * The model layer is advisory/review-only. The run-cycle tool can only execute
 * actions already accepted by the deterministic autopilot, and broadcasts still
 * require args.execute=true + args.live=true + the server live-trading switch.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const agentName = url.searchParams.get("agent")?.trim();
  if (!agentName) {
    return Response.json(
      { error: "agent query parameter is required" },
      { status: 400 },
    );
  }
  return withSolard(request, async (slrd) => {
    const agent = slrd.agent(agentName);
    return {
      agent: agentName,
      status: await agent.meteoraIntelligence.status(),
      tools: agent.meteoraIntelligenceTools(),
    };
  });
}

export async function POST(request: Request): Promise<Response> {
  const body = await readJson(request);
  return withSolard(request, async (slrd) => {
    const agentName = requireString(body, "agent");
    const tool = requireString(body, "tool");
    const agent = slrd.agent(agentName);
    const result = await agent.runMeteoraIntelligenceTool(
      tool,
      argsObject(body.args),
    );
    return { agent: agentName, tool, result };
  });
}
