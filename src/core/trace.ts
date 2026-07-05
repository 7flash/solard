import { createMeasure } from "measure-fn";
const tracer = createMeasure("sowl:trace", { maxResultLength: 800 });

/** Human-readable progress tracing for scripts and CLI diagnosis. */
export function trace(message: string): void {
  if (process.env.SOWL_TRACE !== "1" && process.env.SOWL_TRACE !== "true") return;
  tracer.measureSync(message);
}

export async function withTimeout<T>(label: string, promise: Promise<T>, timeoutMs = Number(process.env.SOWL_RPC_TIMEOUT_MS ?? "15000")): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
