/**
 * Hook + socket tracing — runtime diagnostics for figuring out what's
 * happening during an action.
 *
 *   - `trace_hook`  — single named hook, capture N firings or N ms
 *   - `trace_hooks` — multiple hooks at once, time-ordered timeline
 *   - `trace_socket`— tap `game.socket` for a window, in/out events
 */
import { z }                                  from "zod";
import { registerRoutedTool, registerRawTool } from "./_helpers.js";
import { requestFoundry }                     from "../lib/foundry-rpc.js";
import { diffProjections }                    from "../lib/snapshot-store.js";
import { WORKFLOW_PRESETS, PRESET_KEYS, presetCatalogue }
                                              from "../lib/workflow-presets.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function registerTracingTools(mcp) {
  registerRoutedTool(mcp, "trace_hook",
    "Register a temporary listener on a named Foundry hook, collect up to " +
    "`count` firings (or until `timeoutMs` elapses), unregister, and return " +
    "the serialized arguments of each invocation. Documents are summarised to " +
    "{ _document, id, name, uuid }. Useful for discovering what a hook actually " +
    "receives at runtime.",
    {
      hook:      z.string().describe("Hook name (e.g. 'renderVagabondCharacterSheet', 'updateActor')"),
      count:     z.number().optional().describe("Max firings to collect (1–20). Default 1."),
      timeoutMs: z.number().optional().describe("Give up after this many ms (100–12000). Default 5000."),
    });

  registerRoutedTool(mcp, "trace_hooks",
    "Register listeners on multiple Foundry hooks at once and return a single " +
    "time-ordered timeline of every firing. Each entry is { at, dt, hook, args } " +
    "where `dt` is ms since the first firing. Use this to diagnose hook-order " +
    "bugs — e.g. trace ['preCreateActor', 'createActor', 'preUpdateActor', " +
    "'updateActor', 'renderActorSheet'] during an action and see the exact sequence.",
    {
      hooks:     z.array(z.string()).describe("Array of hook names to listen on simultaneously."),
      count:     z.number().optional().describe("Max total firings across all hooks (1–500). Default 50."),
      timeoutMs: z.number().optional().describe("Give up after this many ms (100–30000). Default 5000."),
      until:     z.string().optional().describe("Stop as soon as this hook fires (must be in `hooks`)."),
    });

  registerRoutedTool(mcp, "trace_socket",
    "Tap `game.socket` for a time window. Captures outgoing `socket.emit` calls " +
    "and incoming events (via Socket.IO `onAny`). Returns time-ordered " +
    "{ at, dt, dir: 'in'|'out', event, args }. Indispensable for debugging " +
    "socket-driven state sync (e.g. modules that use 'module.<id>' events to " +
    "broadcast state between GM and players). Optional `filter` is a substring " +
    "match on event name. Caveat: don't run two trace_socket calls in parallel.",
    {
      filter:    z.string().optional().describe("Only record events whose name contains this substring (e.g. 'module.vagabond-crawler')."),
      count:     z.number().optional().describe("Max events to capture (1–1000). Default 100."),
      timeoutMs: z.number().optional().describe("Give up after this many ms (100–30000). Default 5000."),
    });

  // -------------------------------------------------------------------------
  // trace_workflow — preset-driven, one-call investigation.
  //
  // Wraps the existing snapshot_actors + trace_hooks bridge handlers:
  //   1. (optional) snapshot `watch` actors  → "before"
  //   2. open a trace_hooks window on the preset's hook list
  //   3. (optional) fire `trigger` mid-window so the action happens inside it
  //   4. (optional) re-snapshot + diff           → "what changed"
  //
  // No bridge.js changes: it's pure server-side orchestration over RPCs the
  // bridge already exposes. The value it adds is the PRESET (exact hook names —
  // Foundry has no wildcard hook matching) and the snapshot↔trace correlation.
  //
  // VERIFIED against a live Midi-QOL v14 world (dnd5e 5.3.3): the preset hook
  // names fire as listed and the trigger path captures the full workflow when
  // driven via `use_item`. Two gotchas learned there, now handled:
  //   - the trigger must go through Midi (use_item → item.use()); request_item_use
  //     bypasses Midi and fires zero midi-qol.* hooks.
  //   - rpcTimeout below must outlast the trace window (the server→Foundry RPC
  //     default is 15s), or the RPC times out before the window closes.
  // Remaining heuristic: the triggerDelayMs registration beat (default 150ms).
  // TODO: replace it with an ack once trace_hooks reports "listeners live".
  // -------------------------------------------------------------------------
  registerRawTool(mcp, "trace_workflow",
    "One-call workflow investigation. Expands a named PRESET into the exact "
    + "hook list (Foundry has no wildcard hook matching, so the preset is how "
    + "you trace e.g. a full Midi-QOL workflow without memorising ~12 hook "
    + "strings), opens a trace window, and — if you pass `watch` — snapshots "
    + "those actors before/after and returns a structural diff alongside the "
    + "hook timeline. Optionally fires `trigger` (any bridge tool) INSIDE the "
    + "window so the action and its trace are one call. For the Midi presets the "
    + "trigger MUST invoke Midi's workflow — use `use_item` (calls item.use(), "
    + "which Midi patches via libWrapper), NOT `request_item_use` (it bypasses "
    + "Midi through a direct dispatcher, so no midi-qol.* hooks fire). Returns "
    + "{ preset, hooks, timeline, reason, diff?, summary? }.\n\n"
    + "Presets:\n  " + presetCatalogue(),
    {
      preset: z.enum(PRESET_KEYS).describe("Which workflow preset to trace."),
      watch: z.union([z.string(), z.array(z.string())]).optional().describe(
        "Actor id(s)/name(s) to snapshot before and after, then diff. Omit to "
        + "only collect the hook timeline."),
      select: z.array(z.string()).optional().describe(
        "Override the preset's default snapshot selectors (snapshot_actors "
        + "grammar). Omit to use the preset's scenario-tuned scope."),
      extraHooks: z.array(z.string()).optional().describe(
        "Additional hook names to merge into the preset's list (e.g. a suspect "
        + "module's own hooks)."),
      trigger: z.object({
        tool:   z.string().describe("Bridge tool to fire mid-window, e.g. 'request_item_use'."),
        params: z.record(z.any()).optional().describe("Params for that tool."),
      }).optional().describe(
        "Fire this bridge tool inside the trace window so its hooks are "
        + "captured. Omit if you trigger the action by other means."),
      triggerDelayMs: z.number().optional().describe(
        "Delay before firing `trigger`, to let listeners register (default 150)."),
      count:     z.number().optional().describe("Max total firings (1–500). Default 200."),
      timeoutMs: z.number().optional().describe("Window length in ms (100–30000). Default 8000."),
      until:     z.string().optional().describe(
        "Stop when this hook fires. Defaults to the preset's terminal hook."),
      targetUser: z.string().optional().describe(
        'Foundry user to route to. Omit for GM (default).'),
    },
    async (args) => {
      const {
        preset, watch, select, extraHooks, trigger,
        triggerDelayMs, count, timeoutMs, until, targetUser,
      } = args;

      const def = WORKFLOW_PRESETS[preset];
      if (!def) {
        return { content: [{ type: "text", text:
          `Error: unknown preset "${preset}". Known: ${PRESET_KEYS.join(", ")}.` }] };
      }

      const hooks = [...new Set([...def.hooks, ...(extraHooks || [])])];
      const watchRefs = watch == null ? [] : (Array.isArray(watch) ? watch : [watch]);
      const effSelect = select ?? def.select ?? undefined;
      const traceParams = {
        hooks,
        count:     count ?? 200,
        timeoutMs: timeoutMs ?? 8000,
        until:     until ?? def.until ?? undefined,
      };
      // The server→Foundry RPC has its own default timeout (REQUEST_TIMEOUT,
      // 15s). The trace window can be longer than that, and the trigger may
      // run for the whole window, so both RPCs must be given a deadline that
      // outlasts the window — otherwise the RPC times out before the bridge
      // closes the trace and returns the timeline.
      const rpcTimeout = traceParams.timeoutMs + 5000;

      try {
        // 1. before-snapshot
        let before = null;
        if (watchRefs.length) {
          const snap = await requestFoundry(
            "snapshot_actors", { actors: watchRefs, select: effSelect }, targetUser);
          if (snap?.error) {
            return { content: [{ type: "text", text: `Error (snapshot before): ${snap.error}` }] };
          }
          before = snap.actors || {};
        }

        // 2. open the trace window (don't await yet)
        const tracePromise = requestFoundry("trace_hooks", traceParams, targetUser, rpcTimeout);

        // 3. fire the trigger inside the window, after a registration beat
        let triggerError = null;
        if (trigger?.tool) {
          await sleep(Math.max(0, triggerDelayMs ?? 150));
          try {
            const tRes = await requestFoundry(trigger.tool, trigger.params || {}, targetUser, rpcTimeout);
            if (tRes?.error) triggerError = tRes.error;
          } catch (err) {
            triggerError = err.message;
          }
        }

        const traceResult = await tracePromise;
        if (traceResult?.error) {
          return { content: [{ type: "text", text: `Error (trace): ${traceResult.error}` }] };
        }

        // 4. after-snapshot + diff
        let diff = null, summary = null;
        if (watchRefs.length) {
          const snap2 = await requestFoundry(
            "snapshot_actors", { actors: watchRefs, select: effSelect }, targetUser);
          if (snap2?.error) {
            return { content: [{ type: "text", text: `Error (snapshot after): ${snap2.error}` }] };
          }
          const after = snap2.actors || {};
          const changes = [];
          for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
            if (!after[id])  { changes.push({ actorId: id, op: "actorMissing" }); continue; }
            if (!before[id]) { changes.push({ actorId: id, op: "actorAdded"   }); continue; }
            changes.push(...diffProjections(before[id], after[id], id));
          }
          summary = {};
          for (const c of changes) summary[c.op] = (summary[c.op] || 0) + 1;
          diff = changes;
        }

        return { content: [{ type: "text", text: JSON.stringify({
          preset,
          hooks,
          reason:   traceResult.reason,
          timeline: traceResult.timeline,
          ...(diff    ? { diff, summary } : {}),
          ...(triggerError ? { triggerError } : {}),
        }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    });
}
