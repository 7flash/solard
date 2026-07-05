/**
 * Compatibility adapter for measure-fn runtimes.
 *
 * Newer measure-fn versions accept `{ result: mapper }`, but older linked Bun
 * installs print the raw returned value. These helpers always return a compact
 * summary from the measured callback while retaining the real application value
 * outside the callback. Logs therefore stay safe and compact on either runtime.
 */
type AsyncMeasure = {
  assert<T>(label: string, fn: () => Promise<T>): Promise<T>;
};
type SyncMeasure = {
  assert<T>(label: string, fn: () => T): T;
};
type Scope = { measure: AsyncMeasure; measureSync: SyncMeasure };

export async function measured<T, L>(scope: Scope, label: string, operation: () => Promise<T>, logValue: (value: T) => L): Promise<T> {
  let value: T | undefined;
  await scope.measure.assert(label, async () => {
    value = await operation();
    return logValue(value);
  });
  if (value === undefined) throw new Error(`Measured operation ${label} produced no result`);
  return value;
}

export function measuredSync<T, L>(scope: Scope, label: string, operation: () => T, logValue: (value: T) => L): T {
  let value: T | undefined;
  scope.measureSync.assert(label, () => {
    value = operation();
    return logValue(value);
  });
  if (value === undefined) throw new Error(`Measured operation ${label} produced no result`);
  return value;
}
