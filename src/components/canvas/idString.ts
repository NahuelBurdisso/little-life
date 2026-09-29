/**
 * `String(id)` memoised for per-frame code.
 *
 * Sprite pools, bubble maps and link lines are keyed by the stringified agent id, and the
 * ticker stringified it again for every agent on every frame. Ids are a small closed set
 * (the town's residents), so the cache stays a few dozen entries; nothing needs to evict.
 */
const cache = new Map<number | string, string>();

export function idString(id: number | string): string {
  if (typeof id === 'string') return id;
  let s = cache.get(id);
  if (s === undefined) {
    s = String(id);
    cache.set(id, s);
  }
  return s;
}

const pairCache = new Map<string, Map<string, string>>();

/**
 * `${a}:${b}` memoised — the per-frame pose-emote cooldown key ("agentId:emote"). Both halves come
 * from small closed sets, so the two-level cache stays bounded and repeat lookups return the same
 * string without concatenating.
 */
export function pairKey(a: string, b: string): string {
  let inner = pairCache.get(a);
  if (!inner) {
    inner = new Map();
    pairCache.set(a, inner);
  }
  let key = inner.get(b);
  if (key === undefined) {
    key = `${a}:${b}`;
    inner.set(b, key);
  }
  return key;
}
