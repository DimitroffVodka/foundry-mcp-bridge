/**
 * Hot-reload — picks up edits to `tools/*.js` without restarting the server
 * or disconnecting MCP clients.
 *
 * How it works:
 *
 *   1. Each session's `McpServer` instance gets a registry of the tools it
 *      has registered, indexed by name → `registeredTool` handle from the SDK.
 *   2. Tool registration goes through `upsertRoutedTool` / `upsertRawTool`
 *      which check the registry first: if the name exists, call
 *      `registeredTool.update({ description, paramsSchema, callback })` —
 *      the SDK auto-fires `notifications/tools/list_changed` so clients
 *      refresh their manifest. If new, register fresh and track.
 *   3. The file watcher debounces tools/*.js changes, dynamic-imports
 *      `tools/index.js?t=<ts>` (cache-busting), and calls `registerTools`
 *      again on every active session. Tools that didn't get re-registered
 *      are removed via `registeredTool.remove()`.
 *
 * Scope of "hot":
 *   - tools/*.js edits: live, no restart
 *   - tools/index.js edits: live (re-imported each cycle)
 *   - lib/*.js edits: NOT hot. Those are imported transitively by tools/*
 *     modules and the cached lib modules are shared. Restart the server
 *     for lib/ changes.
 *
 * Client compat:
 *   - Claude Code: full hot-reload, including schema/description changes
 *     (handles list_changed notifications correctly).
 *   - Claude Desktop: handler-body changes are live (next call hits new
 *     code). Schema/description/new/removed tool changes may need a
 *     Desktop restart depending on whether the proxy.mjs shim forwards
 *     list_changed notifications. Worst case: behavior fixes still go
 *     live without a restart.
 */
import { watch } from "fs";
import path      from "path";
import { fileURLToPath } from "url";
import { log }   from "./log.js";

// Per-session registry. Keyed by the McpServer instance so multiple sessions
// don't fight over names. Each entry: { name → registeredTool }.
const sessionRegistries = new WeakMap();

/**
 * Lookup or initialize a session's tool registry. Each McpServer instance
 * gets its own — the SDK's `_registeredTools` is per-instance too.
 */
function registryFor(mcp) {
  let reg = sessionRegistries.get(mcp);
  if (!reg) {
    reg = new Map();
    sessionRegistries.set(mcp, reg);
  }
  return reg;
}

/**
 * Register a tool, or update it if it's already on this session's mcp
 * instance. Mirrors `mcp.tool(name, description, paramsSchema, callback)`
 * but with hot-reload-aware upsert semantics.
 *
 * Returns the registeredTool handle so callers can store it if they want
 * to enable/disable/remove it later (none currently do, but keeps the
 * shape compatible with the SDK).
 */
export function upsertTool(mcp, name, description, paramsSchema, callback) {
  const reg = registryFor(mcp);
  const existing = reg.get(name);
  if (existing) {
    // Update fires sendToolListChanged() internally per SDK.
    existing.update({ description, paramsSchema, callback });
    return existing;
  }
  const registered = mcp.tool(name, description, paramsSchema, callback);
  reg.set(name, registered);
  return registered;
}

/**
 * Per-tools-pass tracker. The watcher uses this to know which tool names
 * a re-registration round produced, so it can remove anything that
 * disappeared from the source.
 */
const passTracker = new WeakMap(); // mcp → Set<name>

export function startTrackingPass(mcp) {
  passTracker.set(mcp, new Set());
}

export function endTrackingPass(mcp) {
  const seen = passTracker.get(mcp) ?? new Set();
  passTracker.delete(mcp);
  const reg = registryFor(mcp);
  let removed = 0;
  for (const [name, registeredTool] of [...reg.entries()]) {
    if (!seen.has(name)) {
      registeredTool.remove();   // SDK fires sendToolListChanged()
      reg.delete(name);
      removed++;
    }
  }
  return { current: reg.size, removed };
}

export function noteTrackedTool(mcp, name) {
  passTracker.get(mcp)?.add(name);
}

/**
 * Watch tools/*.js (and tools/index.js) and trigger a reload pass on every
 * registered session whenever a tool file changes.
 *
 * @param {() => Iterable<McpServer>} getActiveSessions  must return the live
 *   McpServer instances for currently-open sessions (server.js owns the
 *   sessions Map; we get a getter so we don't have to import it).
 *
 * @returns {() => void} stop function (closes the watcher)
 */
export function startHotReloadWatcher(getActiveSessions) {
  // Resolve absolute path to the tools dir relative to this file.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const toolsDir = path.resolve(here, "../tools");

  // Debounce: editor saves often fire multiple events for one logical save.
  let debounceTimer = null;
  let pendingFiles = new Set();

  const onChange = (eventType, filename) => {
    if (!filename || !filename.endsWith(".js")) return;
    pendingFiles.add(filename);
    if (debounceTimer) return;
    debounceTimer = setTimeout(async () => {
      const filesThisCycle = [...pendingFiles];
      pendingFiles.clear();
      debounceTimer = null;
      await reloadAll(getActiveSessions, filesThisCycle);
    }, 300);  // Windows fs.watch fires change + rename per save; 300ms coalesces both.
  };

  let watcher;
  try {
    watcher = watch(toolsDir, { recursive: false }, onChange);
    log(`Hot-reload watcher armed on ${toolsDir}`);
  } catch (e) {
    log(`Hot-reload watcher failed to start: ${e.message}`);
    return () => {};
  }

  return () => watcher.close();
}

/**
 * Re-import tools/index.js with a cache-bust query, then re-register tools
 * on every active session. Each session's registry detects existing tools
 * and updates them, registers new ones, and removes any that disappeared.
 */
async function reloadAll(getActiveSessions, files) {
  const sessions = [...getActiveSessions()];
  if (sessions.length === 0) {
    log(`Hot-reload: ${files.join(", ")} changed but no active sessions — skipped`);
    return;
  }

  // tools/index.js is itself cache-busted because we want a fresh closure
  // over the inner Promise.all of cache-busted children. Without busting
  // the parent too, the same registerTools function reference is reused —
  // which is fine since it itself does Date.now() at call time, but the
  // cache-bust on the parent guards against future edits to index.js too.
  let toolsIndex;
  try {
    toolsIndex = await import(`../tools/index.js?t=${Date.now()}`);
  } catch (e) {
    log(`Hot-reload import failed: ${e.message}`);
    return;
  }
  const { registerTools } = toolsIndex;
  if (typeof registerTools !== "function") {
    log("Hot-reload: tools/index.js no longer exports registerTools — skipped");
    return;
  }

  let totalRefreshed = 0;
  let totalRemoved = 0;
  const sessionCount = sessions.length;
  for (const mcp of sessions) {
    startTrackingPass(mcp);
    try {
      await registerTools(mcp);
    } catch (e) {
      log(`Hot-reload: registerTools threw on a session: ${e.message}`);
      endTrackingPass(mcp);
      continue;
    }
    const { current, removed } = endTrackingPass(mcp);
    totalRefreshed += current;
    totalRemoved += removed;
  }
  log(`Hot-reload: ${files.join(", ")} → ${sessionCount} session(s), `
    + `${totalRefreshed} tool registrations refreshed, ${totalRemoved} removed`);
}
