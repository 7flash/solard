/** A slow request must not manufacture a fresh sample timestamp on completion.
 * Request start is a conservative upper bound when the source cannot prove a
 * newer observation time (including quote conversion reads in the same call). */
export function sampleObservationTime(startedAtMs: number, sourceAtMs: number, receivedAtMs: number): number {
  if (![startedAtMs, sourceAtMs, receivedAtMs].every(value => Number.isFinite(value) && value >= 0) ||
      startedAtMs > receivedAtMs || sourceAtMs > receivedAtMs)
    throw Error("Invalid market observation timestamp");
  return Math.min(startedAtMs, sourceAtMs);
}
