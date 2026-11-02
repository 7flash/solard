export type FixedPriceBand = { kind: "fixed"; buyPriceSol: string; sellPriceSol: string; entryPaused?: true };
export function positivePrice(value?: string): string {
 const decimal=/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
 if(!value||!decimal.test(value)||!Number.isFinite(Number(value))||Number(value)<=0)
  throw new Error("Price or market cap must be a positive finite decimal");
 return value;
}
export function fixedPriceBand(buy?: string, sell?: string): FixedPriceBand {
 const decimal=/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
 if(!buy||!sell||!decimal.test(buy)||!decimal.test(sell)||!Number.isFinite(Number(buy))||!Number.isFinite(Number(sell))||Number(buy)<=0||Number(sell)<=Number(buy))
  throw new Error("Provide positive --buy-price-sol and --sell-price-sol, with sell greater than buy");
 return {kind:"fixed",buyPriceSol:buy,sellPriceSol:sell};
}
export function fixedPriceSignal(phase: "buy"|"sell",price: number,band: FixedPriceBand, entryPaused = false): "buy"|"sell"|null {
 if(!Number.isFinite(price)||price<=0)throw new Error("Invalid current price");
 if(phase==='buy'&&(band.entryPaused||entryPaused))return null;
 return phase==="buy"&&price<=Number(band.buyPriceSol)?"buy":phase==="sell"&&price>=Number(band.sellPriceSol)?"sell":null;
}
