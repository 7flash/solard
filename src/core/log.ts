import { createMeasure } from "measure-fn";
export function measure(scope: string) {
  return createMeasure(`sowl:${scope}`, { maxResultLength: 1600 });
}
export function shortKey(value: string): string {
  return value.length <= 14 ? value : `${value.slice(0, 6)}…${value.slice(-6)}`;
}
