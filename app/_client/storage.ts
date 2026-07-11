export function canUseStorage(): boolean {
  return (
    typeof window !== "undefined" && typeof window.localStorage !== "undefined"
  );
}

export function storageGet(key: string, fallback = ""): string {
  try {
    if (!canUseStorage()) return fallback;
    const value = window.localStorage.getItem(key);
    return value == null ? fallback : value;
  } catch {
    return fallback;
  }
}

export function storageSet(key: string, value: string): void {
  try {
    if (!canUseStorage()) return;
    window.localStorage.setItem(key, value);
  } catch {
    // Storage is optional. Private mode / locked-down browsers should not break pages.
  }
}

export function storageFlag(key: string, fallback = false): boolean {
  const value = storageGet(key, fallback ? "1" : "0");
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function storageJson<T>(key: string, fallback: T): T {
  try {
    const raw = storageGet(key, "");
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
