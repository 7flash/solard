import type {
  MeteoraIntelligenceConfig,
  MeteoraIntelligenceDecisionInput,
  MeteoraModelCycleDecision,
} from "./meteora-intelligence-types.ts";

type Dict = Record<string, unknown>;

function isObject(value: unknown): value is Dict {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | null {
  if (value == null) return null;
  const result = String(value).trim();
  return result || null;
}

function num(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDecision(value: unknown): MeteoraModelCycleDecision {
  if (!isObject(value)) throw new Error("Model response is not a JSON object");
  const rawDeployment = isObject(value.deployment) ? value.deployment : {};
  const management = Array.isArray(value.management)
    ? value.management
        .filter(isObject)
        .map((item) => ({
          position: text(item.position) ?? "",
          approve: item.approve === true,
          reason: text(item.reason) ?? "model decision",
        }))
        .filter((item) => !!item.position)
    : [];
  const lessons = Array.isArray(value.lessons)
    ? value.lessons
        .filter(isObject)
        .map((item) => ({
          rule: text(item.rule) ?? "",
          tags: Array.isArray(item.tags)
            ? item.tags
                .map((tag) => String(tag).trim())
                .filter(Boolean)
                .slice(0, 20)
            : [],
          role: (["SCREENER", "MANAGER", "GENERAL"] as const).includes(
            text(item.role) as any,
          )
            ? (text(item.role) as "SCREENER" | "MANAGER" | "GENERAL")
            : null,
          pinned: item.pinned === true,
        }))
        .filter((item) => !!item.rule)
        .slice(0, 5)
    : [];

  return {
    deployment: {
      approve: rawDeployment.approve === true,
      pool: text(rawDeployment.pool),
      reason: text(rawDeployment.reason) ?? "model decision",
      strategyId: text(rawDeployment.strategy_id ?? rawDeployment.strategyId),
      binsBelow: num(rawDeployment.bins_below ?? rawDeployment.binsBelow),
      binsAbove: num(rawDeployment.bins_above ?? rawDeployment.binsAbove),
    },
    management,
    lessons,
    summary: text(value.summary) ?? "model reviewed cycle",
  };
}

export interface MeteoraDecisionModel {
  readonly id: string;
  decide(
    input: MeteoraIntelligenceDecisionInput,
  ): Promise<MeteoraModelCycleDecision>;
}

const SYSTEM_PROMPT = `You are the policy reviewer for a Meteora DLMM liquidity agent.
You do not construct transactions and you cannot bypass deterministic risk controls.
Only choose a deployment from candidates where eligible=true. You may skip deployment.
For management, you may only approve or skip actions already present in cyclePlan.management; never invent a new management action.
Respect persistent position instructions, blacklist, pool memory, active strategy, token audits, holder concentration, smart-wallet signals, indicators, and top-LPer evidence.
Prefer skipping over weak, conflicting, unavailable, or suspicious evidence.
Return JSON only with this exact shape:
{
  "deployment": {"approve": boolean, "pool": string|null, "reason": string, "strategy_id": string|null, "bins_below": number|null, "bins_above": number|null},
  "management": [{"position": string, "approve": boolean, "reason": string}],
  "lessons": [{"rule": string, "tags": string[], "role": "SCREENER"|"MANAGER"|"GENERAL"|null, "pinned": boolean}],
  "summary": string
}`;

function modelBaseUrl(config: MeteoraIntelligenceConfig): string {
  return config.model.baseUrl.replace(/\/+$/, "");
}

export class OpenAiCompatibleMeteoraDecisionModel implements MeteoraDecisionModel {
  readonly id: string;

  constructor(private readonly config: MeteoraIntelligenceConfig) {
    if (!config.model.model)
      throw new Error("Meteora intelligence model name is not configured");
    if (!config.model.baseUrl)
      throw new Error("Meteora intelligence model base URL is not configured");
    this.id = `openai-compatible:${config.model.model}`;
  }

  async decide(
    input: MeteoraIntelligenceDecisionInput,
  ): Promise<MeteoraModelCycleDecision> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Math.max(1_000, this.config.model.timeoutMs),
    );
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (this.config.model.apiKey)
        headers.authorization = `Bearer ${this.config.model.apiKey}`;
      const response = await fetch(
        `${modelBaseUrl(this.config)}/chat/completions`,
        {
          method: "POST",
          headers,
          signal: controller.signal,
          body: JSON.stringify({
            model: this.config.model.model,
            temperature: this.config.model.temperature,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              {
                role: "user",
                content: JSON.stringify(input),
              },
            ],
          }),
        },
      );
      const body = (await response.json().catch(() => ({}))) as any;
      if (!response.ok) {
        const message =
          body?.error?.message ??
          body?.message ??
          `model HTTP ${response.status}`;
        throw new Error(String(message));
      }
      const content = body?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim())
        throw new Error("Model returned no message content");
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        throw new Error("Model returned invalid JSON");
      }
      return parseDecision(parsed);
    } finally {
      clearTimeout(timeout);
    }
  }
}
