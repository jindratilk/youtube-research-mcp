// Short-lived in-process memo so a search followed by a fetch of the same
// videos does not hit YouTube twice. Not a store: entries expire in minutes.

const TTL_MS = Number(process.env.YT_CACHE_TTL_MS ?? 15 * 60_000);
const MAX_ENTRIES = 500;

export function memo<A extends string, R>(name: string, fn: (key: A) => Promise<R>): (key: A) => Promise<R> {
  const entries = new Map<string, { at: number; value: Promise<R> }>();
  return (key: A) => {
    const hit = entries.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
    const value = fn(key);
    // Failures are not cached: the next call should retry.
    value.catch(() => entries.delete(key));
    entries.set(key, { at: Date.now(), value });
    if (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
    return value;
  };
}
