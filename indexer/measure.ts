export {
  compactId,
  DB_RETRY,
  indexerMeasure,
  summarizeError,
  summarizeForMeasure as summarizeValue,
} from "../shared/measure.js";

export function json(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    typeof item === "bigint" ? item.toString() : item,
  );
}
