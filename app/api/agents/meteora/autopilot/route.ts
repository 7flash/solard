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
 * Autonomous Meteora LP policy bridge.
 *
 * GET  /api/agents/meteora/autopilot?agent=<name> -> policy tool schemas + config
 * POST /api/agents/meteora/autopilot              -> run one policy tool
 *   { "agent": "lp-agent", "tool": "meteora_autopilot_plan_cycle", "args": {} }
 *
 * The run-cycle tool is read-only unless args.execute=true AND args.live=true.
 * The core Meteora service also enforces Solard's server live-trading master switch.
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
      config: agent.meteoraAutopilot.config(),
      tools: agent.meteoraAutopilotTools(),
    };
  });
}

export async function POST(request: Request): Promise<Response> {
  const body = await readJson(request);
  return withSolard(request, async (slrd) => {
    const agentName = requireString(body, "agent");
    const tool = requireString(body, "tool");
    const agent = slrd.agent(agentName);
    const result = await agent.runMeteoraAutopilotTool(
      tool,
      argsObject(body.args),
    );
    return { agent: agentName, tool, result };
  });
}
