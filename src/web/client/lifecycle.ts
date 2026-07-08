export type Cleanup = () => void;

export function createCleanupBag() {
  const cleanups = new Set<Cleanup>();
  return {
    add(cleanup: Cleanup): Cleanup {
      cleanups.add(cleanup);
      return () => cleanups.delete(cleanup);
    },
    interval(id: ReturnType<typeof setInterval>): void {
      cleanups.add(() => clearInterval(id));
    },
    timeout(id: ReturnType<typeof setTimeout>): void {
      cleanups.add(() => clearTimeout(id));
    },
    run(): void {
      const rows = [...cleanups];
      cleanups.clear();
      for (const cleanup of rows) {
        try {
          cleanup();
        } catch {
          // Cleanup must never block route switching or beforeunload.
        }
      }
    },
  };
}
