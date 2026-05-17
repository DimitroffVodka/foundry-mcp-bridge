/**
 * Hook + socket tracing — runtime diagnostics for figuring out what's
 * happening during an action.
 *
 *   - `trace_hook`  — single named hook, capture N firings or N ms
 *   - `trace_hooks` — multiple hooks at once, time-ordered timeline
 *   - `trace_socket`— tap `game.socket` for a window, in/out events
 */
import { z }                  from "zod";
import { registerRoutedTool } from "./_helpers.js";

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
}
