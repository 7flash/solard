import type { HumanAmount } from "../core/amounts.ts";
import type { TokenRef, WalletRef } from "../core/refs.ts";
import type { AgentRow } from "../db/schema.ts";
import type { AgentRepo } from "../db/agent-repo.ts";
import type { MeteoraDlmmService } from "../venues/meteora/dlmm.ts";
import { MeteoraAgentFacade } from "./meteora-agent.ts";

export interface AgentHost {
  readonly meteora: MeteoraDlmmService;
  buy(
    token: TokenRef,
    wallet: WalletRef,
    amount: HumanAmount,
    options?: { slippageBps?: number; via?: string },
  ): Promise<unknown>;
  sell(
    token: TokenRef,
    wallet: WalletRef,
    options?: { bps?: number; slippageBps?: number; via?: string },
  ): Promise<unknown>;
  claim(
    token: TokenRef,
    wallet: WalletRef,
    options?: { via?: string },
  ): Promise<unknown>;
}
export class SolardAgent {
  readonly meteora: MeteoraAgentFacade;

  constructor(
    readonly row: AgentRow,
    private readonly repo: AgentRepo,
    private readonly host: AgentHost,
    readonly wallet: WalletRef,
  ) {
    this.meteora = new MeteoraAgentFacade(host.meteora, wallet, (action) => {
      this.repo.saveState(this.row, {
        lastAction: action.tool,
        at: action.at,
        meteora: action,
      });
    });
  }

  meteoraTools() {
    return this.meteora.tools;
  }

  async runMeteoraTool(tool: string, args: unknown = {}) {
    return await this.meteora.call(tool, args);
  }
  async buy(
    token: TokenRef,
    amount: HumanAmount,
    options?: { slippageBps?: number; via?: string },
  ) {
    const result = await this.host.buy(token, this.wallet, amount, options);
    this.repo.saveState(this.row, { lastAction: "buy", at: Date.now() });
    return result;
  }
  async sell(
    token: TokenRef,
    options?: { bps?: number; slippageBps?: number; via?: string },
  ) {
    const result = await this.host.sell(token, this.wallet, options);
    this.repo.saveState(this.row, { lastAction: "sell", at: Date.now() });
    return result;
  }
  async claim(token: TokenRef, options?: { via?: string }) {
    const result = await this.host.claim(token, this.wallet, options);
    this.repo.saveState(this.row, { lastAction: "claim", at: Date.now() });
    return result;
  }
}
