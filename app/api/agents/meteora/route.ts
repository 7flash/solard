import {
  readJson,
  requireString,
  withSolard,
} from "../../../../src/web/http.js";

function argsObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Agent-ready Meteora DLMM bridge.
 *
 * GET  /api/agents/meteora?agent=<name> -> function schemas
 * POST /api/agents/meteora              -> execute one allow-listed tool
 *   { "agent": "lp-agent", "tool": "meteora_get_my_positions", "args": {} }
 *
 * Mutating tool calls prepare only by default. A broadcast requires both
 * args.execute=true and args.live=true, plus the server live-trading master switch.
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
      tools: agent.meteoraTools(),
    };
  });
}

export async function POST(request: Request): Promise<Response> {
  const body = await readJson(request);
  return withSolard(request, async (slrd) => {
    const agentName = requireString(body, "agent");
    const tool = requireString(body, "tool");
    const agent = slrd.agent(agentName);
    const result = await agent.runMeteoraTool(tool, argsObject(body.args));
    return { agent: agentName, tool, result };
  });
}
