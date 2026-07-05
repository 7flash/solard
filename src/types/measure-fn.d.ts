declare module "measure-fn" {
  export type MeasureAction<T = unknown> = string | {
    label: string;
    budget?: number;
    timeout?: number;
    maxResultLength?: number;
    result?: (value: T) => unknown;
    meta?: Record<string, unknown>;
    [key: string]: unknown;
  };
  export type MeasureFn = {
    <T = null>(action: MeasureAction<T>, fn?: (() => Promise<T>) | ((measure: MeasureFn, measureSync: MeasureSyncFn) => Promise<T>), onError?: (error: unknown) => T | null | Promise<T | null>): Promise<T | null>;
    assert<T>(action: MeasureAction<T>, fn: (() => Promise<T>) | ((measure: MeasureFn) => Promise<T>)): Promise<T>;
  };
  export type MeasureSyncFn = {
    <T = null>(action: MeasureAction<T>, fn?: (() => T) | ((measure: MeasureSyncFn) => T), onError?: (error: unknown) => T | null): T | null;
    assert<T>(action: MeasureAction<T>, fn: (() => T) | ((measure: MeasureSyncFn) => T)): T;
  };
  export type MeasureScope = {
    measure: MeasureFn;
    measureSync: MeasureSyncFn;
    resetCounter(): void;
  };
  export function createMeasure(scope: string, options?: { maxResultLength?: number }): MeasureScope;
  export function configure(options: Record<string, unknown>): void;
  export const measure: MeasureFn;
  export const measureSync: MeasureSyncFn;
}
