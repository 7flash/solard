/**
 * Compatibility adapter for measure-fn runtimes.
 *
 * Some measure-fn builds expose `measure.assert(...)` but only expose
 * `measureSync(...)` as a callable function without `measureSync.assert`.
 * These helpers keep measured return values compact while preserving the real
 * application value, and they work with both runtime shapes.
 */
type AsyncMeasure = {
  assert?: <T>(label: string, fn: () => Promise<T>) => Promise<T>;
  <T>(label: string, fn: () => Promise<T>): Promise<T | null>;
};
type SyncMeasure = {
  assert?: <T>(label: string, fn: () => T) => T;
  <T>(label: string, fn: () => T): T | null;
};
type Scope = { measure: AsyncMeasure; measureSync: SyncMeasure };

async function runMeasuredAsync<T>(
  measure: AsyncMeasure,
  label: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  if (typeof measure.assert === "function")
    return await measure.assert(label, fn);
  return await measure(label, fn);
}

function runMeasuredSync<T>(
  measureSync: SyncMeasure,
  label: string,
  fn: () => T,
): T | null {
  if (typeof measureSync.assert === "function")
    return measureSync.assert(label, fn);
  return measureSync(label, fn);
}

export async function measured<T, L>(
  scope: Scope,
  label: string,
  operation: () => Promise<T>,
  logValue: (value: T) => L,
): Promise<T> {
  let value: T | undefined;
  await runMeasuredAsync(scope.measure, label, async () => {
    value = await operation();
    return logValue(value);
  });
  if (value === undefined)
    throw new Error(`Measured operation ${label} produced no result`);
  return value;
}

export function measuredSync<T, L>(
  scope: Scope,
  label: string,
  operation: () => T,
  logValue: (value: T) => L,
): T {
  let value: T | undefined;
  runMeasuredSync(scope.measureSync, label, () => {
    value = operation();
    return logValue(value);
  });
  if (value === undefined)
    throw new Error(`Measured operation ${label} produced no result`);
  return value;
}
