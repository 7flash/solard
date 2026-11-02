/** Require fresh qualifying observations spanning the hold, never elapsed time on one old tick. */
export class ThresholdHold {
  private window?: { key: string; first: number; last: number };
  constructor(readonly holdMs: number, private readonly maxGapMs: number) {
    if (!Number.isSafeInteger(holdMs) || holdMs < 0 || !Number.isFinite(maxGapMs) || maxGapMs <= 0)
      throw Error("Hold must be non-negative milliseconds and sample gap must be positive");
  }
  reset() { this.window = undefined; }
  observe(key: string | undefined, atMs: number, now: number) {
    if (!key || !Number.isFinite(atMs) || atMs > now || now-atMs > this.maxGapMs) { this.reset(); return; }
    const previous=this.window;
    if (previous?.key===key && atMs===previous.last) return;
    if (!previous || previous.key!==key || atMs<previous.last || atMs-previous.last>this.maxGapMs)
      this.window={key,first:atMs,last:atMs};
    else previous.last=atMs;
  }
  ready(key: string, now: number): boolean {
    if (this.holdMs===0) return true;
    const window=this.window;
    return window?.key===key && now>=window.last && now-window.last<=this.maxGapMs && window.last-window.first>=this.holdMs;
  }
}
