type State = {
  peak: number;
  entry: number | null;
  bought: boolean;
};

export default {
  name: "on-trade-example",
  state: {
    peak: 0,
    entry: null,
    bought: false,
  } satisfies State,

  async onStart(ctx: any) {
    ctx.log("ready", { params: ctx.params, live: ctx.live });
  },

  async onTrade(ctx: any, trade: any) {
    const price = trade.priceSol;
    if (!(price > 0) || trade.isMine) return;

    const dipPct = Number(ctx.params.dipPct ?? 15);
    const takeProfitPct = Number(ctx.params.takeProfitPct ?? 20);
    const buySol = Number(ctx.params.buySol ?? 0.02);
    const sellPct = Number(ctx.params.sellPct ?? 50);

    ctx.state.peak = Math.max(ctx.state.peak, price);

    if (!ctx.state.bought && price <= ctx.state.peak * (1 - dipPct / 100)) {
      const fill = await ctx.buy({
        sol: buySol,
        reason: `${dipPct}% drawdown from local peak`,
      });
      ctx.state.entry = fill.live ? (await ctx.samplePrice()).price : price;
      ctx.state.bought = true;
      return;
    }

    if (
      ctx.state.bought &&
      ctx.state.entry != null &&
      price >= ctx.state.entry * (1 + takeProfitPct / 100)
    ) {
      await ctx.sell({
        percent: sellPct,
        reason: `${takeProfitPct}% rebound from entry`,
      });
      if (!ctx.live || (await ctx.position()).tokenRaw === 0n) {
        ctx.state.bought = false;
        ctx.state.entry = null;
        ctx.state.peak = price;
      }
    }
  },

  async onStop(ctx: any, reason: string) {
    ctx.log("stopped", { reason, state: ctx.state });
  },
};
