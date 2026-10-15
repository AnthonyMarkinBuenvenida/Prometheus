// localStorage helpers. All reads/writes are guarded: storage can be unavailable
// (private mode, blocked site data) or full, and the app must still work.

const PREFIX = "prometheus.v1.";
// The app was called HiveMind before. Data saved under the old prefix is copied to the new one the
// first time it is read, so nobody loses chats or settings; the old copy is left untouched.
const LEGACY_PREFIX = "hivemind.v1.";

export function load<T>(key: string, fallback: T): T {
  try {
    let raw = localStorage.getItem(PREFIX + key);
    if (raw === null) {
      raw = localStorage.getItem(LEGACY_PREFIX + key);
      if (raw !== null) localStorage.setItem(PREFIX + key, raw);
    }
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** Returns false if the value could not be saved (quota exceeded or storage blocked). */
export function save(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
