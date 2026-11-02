/** Revision-based notification: samples arriving during work must not be lost. */
export class SampleWake {
  version = 0;
  private waiters = new Set<() => void>();
  notify() {
    this.version++;
    for (const wake of [...this.waiters]) wake();
  }
  async after(version: number, timeoutMs: number): Promise<void> {
    if (this.version > version) return;
    await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); this.waiters.delete(done); resolve(); };
      const timer = setTimeout(done, Math.max(1, timeoutMs));
      this.waiters.add(done);
    });
  }
}
