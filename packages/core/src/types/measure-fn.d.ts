declare module "measure-fn" {
  export type MeasureLogEvent = {
    type: "start" | "success" | "error" | "annotation" | string;
    id?: string;
    label: string;
    data?: unknown;
    value?: unknown;
    result?: unknown;
    error?: unknown;
    duration?: number;
    depth?: number;
    meta?: Record<string, unknown>;
    [key: string]: unknown;
  };

  export type MeasureLogger = (
    event: MeasureLogEvent,
    next?: () => void,
  ) => void;

  export type MeasureAction<T = unknown> =
    | string
    | {
        start?: () => unknown;
        end?: (value: T) => unknown;
        catch?: (error: unknown) => T | Promise<T>;
        budget?: number;
        timeout?: number;
        maxResultLength?: number;
        summarize?: boolean;
        stripScopePrefix?: boolean;
        meta?: Record<string, unknown>;
        [key: string]: unknown;
      };

  export type MeasureFn = {
    <T = null>(
      action: MeasureAction<T>,
      fn?: (() => Promise<T>) | (() => T),
    ): Promise<T>;
    retry?: (...args: any[]) => Promise<any>;
    wrap?: (...args: any[]) => any;
    batch?: (...args: any[]) => Promise<any>;
    root?: (...args: any[]) => Promise<any>;
    timed?: (...args: any[]) => Promise<any>;
  };

  export type MeasureSyncFn = {
    <T = null>(action: MeasureAction<T>, fn?: () => T): T;
  };

  /**
   * Modern measure-fn scopes are callable. Compatibility properties remain
   * declared because older Solard code still uses m.measure(...) / m.measureSync(...).
   */
  export type MeasureScope = MeasureFn & {
    measure: MeasureFn;
    measureSync: MeasureSyncFn;
    sync: MeasureSyncFn;
    note: (...args: any[]) => unknown;
    retry: (...args: any[]) => Promise<any>;
    wrap: (...args: any[]) => any;
    batch: (...args: any[]) => Promise<any>;
    root: (...args: any[]) => Promise<any>;
    timed: (...args: any[]) => Promise<any>;
    resetCounter?: () => void;
  };

  export function createMeasure(
    scope: string,
    options?: { maxResultLength?: number },
  ): MeasureScope;

  export function configure(options: {
    logger?: MeasureLogger | null;
    [key: string]: unknown;
  }): void;

  export const measure: MeasureFn;
  export const measureSync: MeasureSyncFn;
  export function safeStringify(value: unknown): string;
  export function summarizeForMeasure(value: unknown): unknown;
}
