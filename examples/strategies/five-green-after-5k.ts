type Candle = {
  startAtMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  trades: number;
};

type State = {
  crossedAtMs: number | null;
  firstBucketAtMs: number | null;
  current: Candle | null;
  greenStreak: number;
  alerted: boolean;
};

function positive(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function bucket(atMs: number, candleMs: number): number {
  return Math.floor(atMs / candleMs) * candleMs;
}

function firstFullBucket(atMs: number, candleMs: number): number {
  return Math.ceil(atMs / candleMs) * candleMs;
}

export default {
  name: "five-green-after-5k",
  state: {
    crossedAtMs: null,
    firstBucketAtMs: null,
    current: null,
    greenStreak: 0,
    alerted: false,
  } satisfies State,

  onTrade(ctx: any, trade: any) {
    const candleMs = positive(ctx.params.candleMs, 30_000);
    const required = Math.max(
      1,
      Math.trunc(positive(ctx.params.greenCandles, 5)),
    );
    const threshold = positive(ctx.params.minMarketCapUsd, 5_000);
    const price = Number(trade.priceSol ?? trade.priceUsd);
    const marketCapUsd = Number(trade.marketCapUsd);
    if (!(price > 0)) return;

    if (ctx.state.crossedAtMs == null) {
      if (!(marketCapUsd >= threshold)) return;
      ctx.state.crossedAtMs = trade.atMs;
      ctx.state.firstBucketAtMs = firstFullBucket(trade.atMs, candleMs);
      ctx.log("market-cap gate crossed", { threshold, marketCapUsd });
      return;
    }

    const startAtMs = bucket(trade.atMs, candleMs);
    if (startAtMs < ctx.state.firstBucketAtMs) return;

    const finalize = (candle: Candle, nextStartAtMs: number) => {
      if (nextStartAtMs - candle.startAtMs > candleMs) {
        ctx.state.greenStreak = 0;
        ctx.state.alerted = false;
      }
      if (candle.close > candle.open) {
        ctx.state.greenStreak += 1;
        if (ctx.state.greenStreak >= required && !ctx.state.alerted) {
          ctx.state.alerted = true;
          ctx.notify(
            `${required} consecutive green ${Math.round(candleMs / 1_000)}s candles`,
            {
              mint: trade.mint,
              marketCapUsd,
              greenStreak: ctx.state.greenStreak,
              candleStartAtMs: candle.startAtMs,
              candleEndAtMs: candle.startAtMs + candleMs,
            },
          );
        }
      } else {
        ctx.state.greenStreak = 0;
        ctx.state.alerted = false;
      }
    };

    if (!ctx.state.current) {
      ctx.state.current = {
        startAtMs,
        open: price,
        high: price,
        low: price,
        close: price,
        trades: 1,
      };
      return;
    }

    if (ctx.state.current.startAtMs === startAtMs) {
      ctx.state.current.high = Math.max(ctx.state.current.high, price);
      ctx.state.current.low = Math.min(ctx.state.current.low, price);
      ctx.state.current.close = price;
      ctx.state.current.trades += 1;
      return;
    }

    if (startAtMs > ctx.state.current.startAtMs) {
      finalize(ctx.state.current, startAtMs);
      ctx.state.current = {
        startAtMs,
        open: price,
        high: price,
        low: price,
        close: price,
        trades: 1,
      };
    }
  },
};
