/**
 * Snapshot + diff tools — four flavors:
 *
 *   - `snapshot_actor`  — single actor, full toObject() with optional scope
 *   - `diff_actor`      — diff two actor snapshots (or snapshot vs live)
 *   - `snapshot_actors` — multi-actor + path-selector projection (live walk)
 *   - `diff_with`       — re-snapshot + diff against stored or inline snapshot
 *
 * The first two are simple proxies. The latter two have non-trivial server-
 * side logic (storeId persistence + diff orchestration) and live here.
 */
import { z }                                from "zod";
import { registerRoutedTool, registerRawTool } from "./_helpers.js";
import { requestFoundry }                   from "../lib/foundry-rpc.js";
import { snapshotStore, pruneSnapshotStore, diffProjections } from "../lib/snapshot-store.js";

export function registerSnapshotTools(mcp) {
  // --- Single-actor snapshot/diff (simple proxies) ---
  registerRoutedTool(mcp, "snapshot_actor",
    "Snapshot an actor's current state as plain JSON for later diffing. " +
    "Optional `scope` array limits which sections to include: 'system', 'flags', " +
    "'items', 'effects', 'prototypeToken'. Default is everything except prototypeToken. " +
    "Pass the result to diff_actor after performing an action to verify the change footprint.",
    {
      actor: z.string().describe("Actor id or name."),
      scope: z.array(z.enum(["system","flags","items","effects","prototypeToken"]))
              .optional().describe("Limit which sections to snapshot."),
    });

  registerRoutedTool(mcp, "diff_actor",
    "Compute the structural delta between two actor snapshots (or between a " +
    "snapshot and the actor's current live state). Arrays whose elements have " +
    "`_id` are matched by id, so reordering does not register as a change. " +
    "Returns { total, summary: {added, removed, changed}, changes: [{path, op, before, after}] }. " +
    "Two modes: pass `{before, after}` as JSON, OR pass `{actor, before}` to diff a snapshot against current state.",
    {
      before: z.any().describe("The earlier snapshot (from snapshot_actor)."),
      after:  z.any().optional().describe("The later snapshot. Omit to diff against the actor's live state via `actor`."),
      actor:  z.string().optional().describe("Actor id/name. Use with `before` to diff snapshot vs current state."),
    });

  // --- Multi-actor snapshot + diff (server-side orchestration) ---
  registerRawTool(mcp, "snapshot_actors",
    "Capture structured projections of one or more actors at specific paths "
    + "— faster and more focused than full snapshot_actor when you only "
    + "care about a few fields. Useful as a one-shot 'show me current "
    + "state' before deciding what to do, AND as the 'before' for diff_with.\n\n"
    + "Selectors walk the LIVE actor document, so derived data and "
    + "getter-only properties surface correctly: Active-Effect-modified "
    + "stats (e.g. `system.health.max` after AEs apply), prepareDerivedData "
    + "patches, and computed Sets like `actor.statuses` — none of which "
    + "appear in `actor.toObject()`. This is what test code almost always "
    + "wants.\n\n"
    + "Selector grammar: dot paths plus array wildcards.\n"
    + "  • 'system.health.value'        — scalar / subtree\n"
    + "  • 'effects[*].name'            — wildcard over Array / Foundry "
    + "Collection / Set\n"
    + "  • 'items[*].system.quantity'   — wildcards chain through nested iterables\n"
    + "  • 'items[2].name'              — numeric index for one element\n"
    + "  • 'flags.vagabond'             — whole subtree (returns the object)\n"
    + "  • 'statuses'                   — getter-only Set, returned as array\n\n"
    + "Omit `select` to capture the full `actor.toObject()` under a `_full` "
    + "key — but be aware that path is the persisted source and does NOT "
    + "include derived data. Prefer explicit selectors for test assertions.\n\n"
    + "Pass `storeId` to persist the snapshot server-side (~30min TTL, LRU 50) "
    + "so a later diff_with({storeId}) re-snapshots and diffs in one call.",
    {
      actors: z.union([z.string(), z.array(z.string())]).describe(
        "Actor id(s) or name(s). Single string or array."
      ),
      select: z.array(z.string()).optional().describe(
        "Selector paths. Omit to capture full actor.toObject()."
      ),
      storeId: z.string().optional().describe(
        "If set, snapshot is stored server-side under this ID for later diff_with calls. "
        + "Reusing the same ID overwrites. ~30 min TTL with LRU 50-entry cap."
      ),
      targetUser: z.string().optional().describe(
        'Foundry user to route this call to. Omit (or pass "GM" / "self") '
        + 'for GM (default). Use list_connected_bridges for available targets.'
      ),
    },
    async ({ actors, select, storeId, targetUser }) => {
      let bridgeResult;
      try {
        bridgeResult = await requestFoundry("snapshot_actors", { actors, select }, targetUser);
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
      if (bridgeResult?.error) {
        return { content: [{ type: "text", text: `Error: ${bridgeResult.error}` }] };
      }
      if (storeId) {
        pruneSnapshotStore();
        snapshotStore.set(storeId, {
          actors:    bridgeResult.actors,
          select:    select || null,
          actorRefs: Array.isArray(actors) ? actors : [actors],
          takenAt:   bridgeResult.takenAt,
          targetUser: targetUser || null,
        });
      }
      return { content: [{ type: "text", text: JSON.stringify({
        snapshotId: storeId || null,
        takenAt:    new Date(bridgeResult.takenAt).toISOString(),
        actors:     bridgeResult.actors,
        ...(bridgeResult.errors ? { errors: bridgeResult.errors } : {}),
      }, null, 2) }] };
    });

  registerRawTool(mcp, "diff_with",
    "Diff a previously-stored snapshot (by `storeId`) OR an inline snapshot "
    + "against the CURRENT state of the same actors+selectors. Re-snapshots "
    + "the live game and computes per-path changes. Returns "
    + "`{ changes: [{actorId, path, op, before, after}], summary }`.\n\n"
    + "When using `storeId`, the original `select` and `targetUser` are "
    + "reused automatically — no need to repeat them. Inline mode (passing "
    + "`snapshot` directly) requires you to also pass matching `actors` and "
    + "`select` so the new snapshot uses the same shape.",
    {
      storeId: z.string().optional().describe(
        "ID from a prior snapshot_actors call. Mutually exclusive with `snapshot`."
      ),
      snapshot: z.any().optional().describe(
        "Inline `actors` payload returned by a prior snapshot_actors call (the value "
        + "of the `actors` field). Mutually exclusive with `storeId`."
      ),
      actors: z.union([z.string(), z.array(z.string())]).optional().describe(
        "Required when using inline `snapshot` — the actor list to re-snapshot."
      ),
      select: z.array(z.string()).optional().describe(
        "Required when using inline `snapshot` — the selectors to re-apply."
      ),
      targetUser: z.string().optional().describe(
        'Foundry user to route this call to. Defaults to the user from the original '
        + 'snapshot when using `storeId`, otherwise the GM.'
      ),
    },
    async ({ storeId, snapshot, actors, select, targetUser }) => {
      let beforeActors, beforeSelect, beforeActorRefs;
      if (storeId) {
        const stored = snapshotStore.get(storeId);
        if (!stored) {
          const known = [...snapshotStore.keys()].join(", ") || "(none)";
          return { content: [{ type: "text", text:
            `Error: No snapshot stored under "${storeId}". Available IDs: ${known}.`
          }] };
        }
        beforeActors    = stored.actors;
        beforeSelect    = stored.select;
        beforeActorRefs = stored.actorRefs;
        if (!targetUser) targetUser = stored.targetUser;
      } else if (snapshot) {
        beforeActors    = snapshot;
        beforeSelect    = select || null;
        beforeActorRefs = actors ? (Array.isArray(actors) ? actors : [actors]) : Object.keys(beforeActors);
        if (beforeActorRefs.length === 0) {
          return { content: [{ type: "text", text:
            "Error: Inline `snapshot` mode requires non-empty `actors` (or a snapshot with at least one actor key)."
          }] };
        }
      } else {
        return { content: [{ type: "text", text:
          "Error: Provide either `storeId` (from a prior snapshot_actors call) or `snapshot` (inline)."
        }] };
      }

      // Re-snapshot current state with the same actors+select.
      let currentResult;
      try {
        currentResult = await requestFoundry("snapshot_actors",
          { actors: beforeActorRefs, select: beforeSelect }, targetUser);
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
      if (currentResult?.error) {
        return { content: [{ type: "text", text: `Error: ${currentResult.error}` }] };
      }
      const currentActors = currentResult.actors || {};

      const changes = [];
      const allActorIds = new Set([...Object.keys(beforeActors), ...Object.keys(currentActors)]);
      for (const actorId of allActorIds) {
        const before = beforeActors[actorId];
        const after  = currentActors[actorId];
        if (!after)  { changes.push({ actorId, op: "actorMissing" }); continue; }
        if (!before) { changes.push({ actorId, op: "actorAdded"   }); continue; }
        changes.push(...diffProjections(before, after, actorId));
      }

      const summary = { added: 0, removed: 0, changed: 0, actorAdded: 0, actorMissing: 0 };
      for (const c of changes) summary[c.op] = (summary[c.op] || 0) + 1;

      return { content: [{ type: "text", text: JSON.stringify({
        storeId: storeId || null,
        takenAt: new Date(currentResult.takenAt).toISOString(),
        changes,
        summary,
      }, null, 2) }] };
    });
}
