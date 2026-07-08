/**
 * Compatibility adapter for measure-fn runtimes.
 *
 * Some linked Bun/measure-fn builds expose `scope.measure(label, fn)` and
 * `scope.measureSync(label, fn)` directly, while other builds expose
 * `scope.measure.assert(label, fn)` / `scope.measureSync.assert(label, fn)`.
 *
 * These helpers support both shapes. They keep logs compact by returning the
 * mapped log value from the measured callback, while returning the real
 * application value to callers.
 */
type MaybeAsyncMeasureFn = (<T>(
  label: string,
  fn: () => Promise<T>,
) => Promise<T>) & {
  assert?: <T>(label: string, fn: () => Promise<T>) => Promise<T>;
};

type MaybeSyncMeasureFn = (<T>(label: string, fn: () => T) => T) & {
  assert?: <T>(label: string, fn: () => T) => T;
};

type Scope = {
  measure?: MaybeAsyncMeasureFn;
  measureSync?: MaybeSyncMeasureFn;
};

function hasValue<T>(value: T | undefined): value is T {
  return value !== undefined;
}

export async function measured<T, L>(
  scope: Scope,
  label: string,
  operation: () => Promise<T>,
  logValue: (value: T) => L,
): Promise<T> {
  let value: T | undefined;

  const run = async (): Promise<L> => {
    value = await operation();
    return logValue(value);
  };

  const measure = scope.measure;
  if (measure?.assert) {
    await measure.assert(label, run);
  } else if (typeof measure === "function") {
    await measure(label, run);
  } else {
    await run();
  }

  if (!hasValue(value))
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

  const run = (): L => {
    value = operation();
    return logValue(value);
  };

  const measureSync = scope.measureSync;
  if (measureSync?.assert) {
    measureSync.assert(label, run);
  } else if (typeof measureSync === "function") {
    measureSync(label, run);
  } else {
    run();
  }

  if (!hasValue(value))
    throw new Error(`Measured operation ${label} produced no result`);
  return value;
}
