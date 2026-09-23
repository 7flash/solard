export default {
  name: "on-price-example",
  state: {
    peak: 0,
  },
  async onPrice(ctx: any, price: any) {
    const value = price.priceUsd ?? price.priceSol;
    if (!(typeof value === "number" && Number.isFinite(value) && value > 0))
      return;
    ctx.state.peak = Math.max(ctx.state.peak, value);
    ctx.log("price", {
      at: new Date(price.atMs).toISOString(),
      price: value,
      marketCapUsd: price.marketCapUsd,
      peak: ctx.state.peak,
    });
  },
};
