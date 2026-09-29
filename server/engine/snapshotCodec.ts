// ─── Snapshot store contract + codec helpers ──────────────────────────────────
// The pure half of the sim snapshot mechanism (the DB half is simSnapshots.ts).
// Kept free of DB imports so plain in-memory classes such as TensionTracker can
// implement serialize/restore without pulling the database in with them.

export interface SnapshotStore {
  /** Row key in `sim_snapshots`. Unique across stores. */
  key: string;
  /**
   * Bump when the serialized shape changes incompatibly. A row written by an
   * older version is dropped on load instead of being half-parsed.
   */
  version: number;
  /**
   * A JSON-safe copy of the store, or `undefined` to skip writing this time
   * (a store that is not initialized must not overwrite a good checkpoint).
   */
  serialize(): unknown;
  /**
   * Replace the store's content with `data`. Must be tolerant: the blob is
   * whatever an earlier process wrote, so malformed entries are skipped, never
   * thrown on.
   */
  restore(data: unknown): void;
}

// Shared by the stores so each restore is a few lines of "read what is valid,
// skip the rest" instead of hand-rolled type checks.

/** A plain JSON object, or null. */
export function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** A finite number, or null. */
export function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** An object key that was an agent id before JSON turned it into a string. */
export function asId(key: string): number | null {
  const n = Number(key);
  return key !== '' && Number.isInteger(n) ? n : null;
}

/**
 * Game-minute stamps use `-Infinity` for "never" so that `now - stamp` clears
 * every cooldown. JSON has no infinities (it writes null), so "never" is
 * written as null explicitly and read back as `-Infinity`.
 */
export function encodeStamp(minute: number): number | null {
  return Number.isFinite(minute) ? minute : null;
}

export function decodeStamp(v: unknown): number {
  return asNumber(v) ?? Number.NEGATIVE_INFINITY;
}

/** Map<K, number> → plain object. */
export function numberMapToRecord<K extends string | number>(map: ReadonlyMap<K, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of map) if (Number.isFinite(v)) out[String(k)] = v;
  return out;
}

/** Map<K, number[]> → plain object. */
export function listMapToRecord<K extends string | number>(map: ReadonlyMap<K, readonly number[]>): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const [k, v] of map) out[String(k)] = v.filter(Number.isFinite);
  return out;
}

/** Refill an agent-keyed Map<number, number> from `numberMapToRecord` output. */
export function restoreIdNumberMap(map: Map<number, number>, data: unknown): void {
  map.clear();
  for (const [k, v] of Object.entries(asRecord(data) ?? {})) {
    const id = asId(k);
    const n = asNumber(v);
    if (id !== null && n !== null) map.set(id, n);
  }
}

/** Refill a string-keyed Map<string, number> from `numberMapToRecord` output. */
export function restoreKeyNumberMap(map: Map<string, number>, data: unknown): void {
  map.clear();
  for (const [k, v] of Object.entries(asRecord(data) ?? {})) {
    const n = asNumber(v);
    if (n !== null) map.set(k, n);
  }
}

/** Refill an agent-keyed Map<number, number[]> from `listMapToRecord` output. */
export function restoreIdListMap(map: Map<number, number[]>, data: unknown): void {
  map.clear();
  for (const [k, v] of Object.entries(asRecord(data) ?? {})) {
    const id = asId(k);
    if (id === null || !Array.isArray(v)) continue;
    map.set(id, v.map(asNumber).filter((n): n is number => n !== null));
  }
}
