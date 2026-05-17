/**
 * Snapshot store — backs `snapshot_actors({storeId})` + `diff_with({storeId})`.
 * Bounded with TTL + LRU so it can't grow unboundedly across long-lived sessions.
 *
 * Entry shape:
 *   { actors, select, actorRefs, takenAt, targetUser }
 *
 * `actors` is the projection payload returned by the Foundry-side
 * `snapshot_actors` handler. `actorRefs` is the original list of ids/names
 * passed in; reused on diff to re-snapshot the same set without forcing the
 * caller to repeat them.
 */
import { SNAPSHOT_TTL_MS, SNAPSHOT_MAX_LRU } from "./config.js";

export const snapshotStore = new Map();

/**
 * TTL-expire entries older than SNAPSHOT_TTL_MS, then LRU-evict by oldest
 * `takenAt` if we're still over SNAPSHOT_MAX_LRU.
 */
export function pruneSnapshotStore() {
  const now = Date.now();
  for (const [id, entry] of snapshotStore) {
    if (now - entry.takenAt > SNAPSHOT_TTL_MS) snapshotStore.delete(id);
  }
  if (snapshotStore.size > SNAPSHOT_MAX_LRU) {
    const sorted = [...snapshotStore.entries()].sort((a, b) => a[1].takenAt - b[1].takenAt);
    while (snapshotStore.size > SNAPSHOT_MAX_LRU) {
      snapshotStore.delete(sorted.shift()[0]);
    }
  }
}

/**
 * Diff two projections produced by `snapshot_actors`. Each projection is
 * a flat-ish object keyed by selector path (e.g. `system.health.value`).
 * Coarse equality via JSON.stringify — selectors produce
 * structurally-identical projections on both sides, so key-order isn't
 * an issue.
 */
export function diffProjections(before, after, actorId) {
  const changes = [];
  const beforeKeys = new Set(Object.keys(before || {}));
  const afterKeys  = new Set(Object.keys(after  || {}));
  const allKeys = new Set([...beforeKeys, ...afterKeys]);
  for (const key of allKeys) {
    if (key === "_name") continue;  // metadata, not data
    const b = before?.[key];
    const a = after?.[key];
    if (!afterKeys.has(key))  { changes.push({ actorId, path: key, op: "removed", before: b }); continue; }
    if (!beforeKeys.has(key)) { changes.push({ actorId, path: key, op: "added",   after:  a }); continue; }
    if (JSON.stringify(b) !== JSON.stringify(a)) {
      changes.push({ actorId, path: key, op: "changed", before: b, after: a });
    }
  }
  return changes;
}
