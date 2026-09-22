type Candle = {
  startAtMs: number;
  quote: "SOL" | "USDC";
  volume: number;
  closeMarketCapUsd: number | null;
  trades: number;
};

type State = {
  current: Candle | null;
  history: Candle[];
  lastAlertAtMs: number;
};

function positive(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function median(values: number[]): number | null {
  const rows = values
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  if (!rows.length) return null;
  const middle = Math.floor(rows.length / 2);
  return rows.length % 2 === 0
    ? (rows[middle - 1]! + rows[middle]!) / 2
    : rows[middle]!;
}

export default {
  name: "median-volume-low-mcap",
  state: {
    current: null,
    history: [],
    lastAlertAtMs: 0,
  } satisfies State,

  onTrade(ctx: any, trade: any) {
    const candleMs = Math.max(
      1_000,
      Math.trunc(positive(ctx.params.candleMs, 5_000)),
    );
    const baselineCandles = Math.max(
      3,
      Math.trunc(positive(ctx.params.baselineCandles, 12)),
    );
    const volumeMultiple = positive(ctx.params.volumeMultiple, 3);
    const maxMarketCapRatio = positive(ctx.params.maxMarketCapRatio, 1);
    const scoreThreshold = positive(ctx.params.scoreThreshold, 3);
    const minVsPrevious = positive(ctx.params.minVsPrevious, 1.25);
    const cooldownMs = Math.max(0, Number(ctx.params.cooldownMs ?? 30_000));
    const quote = trade.quote === "USDC" ? "USDC" : "SOL";
    const quoteAmount = Number(trade.quoteAmountUi);
    const marketCapUsd = Number(trade.marketCapUsd);
    if (!(quoteAmount > 0)) return;

    const startAtMs = Math.floor(trade.atMs / candleMs) * candleMs;
    const addTrade = (candle: Candle) => {
      candle.volume += quoteAmount;
      candle.trades += 1;
      if (Number.isFinite(marketCapUsd) && marketCapUsd > 0)
        candle.closeMarketCapUsd = marketCapUsd;
    };

    const evaluate = (closed: Candle) => {
      if (ctx.state.history.length < baselineCandles) return;
      const baseline = ctx.state.history.slice(-baselineCandles);
      if (baseline.some((row: Candle) => row.quote !== closed.quote)) return;
      const medianVolume = median(baseline.map((row: Candle) => row.volume));
      const medianMarketCapUsd = median(
        baseline
          .map((row: Candle) => row.closeMarketCapUsd)
          .filter((value: number | null): value is number => value != null),
      );
      if (
        !(medianVolume && medianVolume > 0) ||
        !(medianMarketCapUsd && medianMarketCapUsd > 0)
      )
        return;
      if (!(closed.closeMarketCapUsd && closed.closeMarketCapUsd > 0)) return;

      const previous = baseline.at(-1)!;
      const volumeRatio = closed.volume / medianVolume;
      const marketCapRatio = closed.closeMarketCapUsd / medianMarketCapUsd;
      const volumeToMcapScore = volumeRatio / Math.max(0.25, marketCapRatio);
      const risingVsPrevious = closed.volume >= previous.volume * minVsPrevious;
      const eligible =
        volumeRatio >= volumeMultiple &&
        marketCapRatio <= maxMarketCapRatio &&
        volumeToMcapScore >= scoreThreshold &&
        risingVsPrevious;

      if (
        eligible &&
        closed.startAtMs - ctx.state.lastAlertAtMs >= cooldownMs
      ) {
        ctx.state.lastAlertAtMs = closed.startAtMs;
        ctx.notify("volume expansion at relatively low market cap", {
          mint: trade.mint,
          quote: closed.quote,
          candleMs,
          volume: closed.volume,
          medianVolume,
          volumeRatio,
          marketCapUsd: closed.closeMarketCapUsd,
          medianMarketCapUsd,
          marketCapRatio,
          volumeToMcapScore,
          trades: closed.trades,
          baselineCandles,
        });
      }
    };

    if (!ctx.state.current) {
      ctx.state.current = {
        startAtMs,
        quote,
        volume: 0,
        closeMarketCapUsd: null,
        trades: 0,
      };
      addTrade(ctx.state.current);
      return;
    }

    if (
      ctx.state.current.startAtMs === startAtMs &&
      ctx.state.current.quote === quote
    ) {
      addTrade(ctx.state.current);
      return;
    }

    if (
      startAtMs > ctx.state.current.startAtMs ||
      ctx.state.current.quote !== quote
    ) {
      const closed = ctx.state.current;
      evaluate(closed);
      if (closed.quote === quote) {
        ctx.state.history.push(closed);
        while (ctx.state.history.length > baselineCandles)
          ctx.state.history.shift();
      } else {
        ctx.state.history = [];
      }
      ctx.state.current = {
        startAtMs,
        quote,
        volume: 0,
        closeMarketCapUsd: null,
        trades: 0,
      };
      addTrade(ctx.state.current);
    }
  },
};
