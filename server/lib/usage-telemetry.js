/**
 * Tool-usage telemetry — records every MCP tool invocation so we can answer
 * "which of the ~67 tools are actually being used, how often, and how well?"
 * (the question EVALUATE-REDUNDANCY.md / MUTATION-TELEMETRY-SPEC.md want data for).
 *
 * Two outputs from one hook:
 *   - in-memory aggregates  → served live at GET /api/usage
 *   - a JSONL append log    → one rich record per call, for offline analysis
 *
 * The hook is a single wrapper installed in `upsertTool` (lib/hot-reload.js),
 * which every tool — routed, raw, merged, and `evaluate` — funnels through. So
 * coverage is 100% with no per-tool changes. This module lives under lib/ which
 * is NOT cache-busted by the hot-reload watcher, so the aggregates and the
 * write chain survive `tools/*.js` edits.
 *
 * On by default; disable with FOUNDRY_MCP_USAGE=0 (or false/no/off), redirect
 * the log with FOUNDRY_MCP_USAGE_LOG=<path>. When disabled, `wrap()` returns
 * the original callback untouched — zero overhead on the call path.
 *
 * The factory (`createUsageTracker`) takes injectable `now`/`appendLine` so the
 * test suite can drive it with a fake clock and capture lines without touching
 * disk — matching the DI style of createEvaluateHandler / diagnoseBridgeStatus.
 */
import { appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { USAGE_TELEMETRY } from "./config.js";
import { log }            from "./log.js";

// Default log path: server/usage-telemetry.jsonl (this file is in server/lib/).
export const DEFAULT_LOG_PATH = fileURLToPath(
  new URL("../usage-telemetry.jsonl", import.meta.url)
);

function truncate(str, max) {
  if (typeof str !== "string") return str;
  return str.length > max ? `${str.slice(0, max)}…(+${str.length - max})` : str;
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

/**
 * Build the rich per-call JSONL record. Args are captured but bounded: the
 * `evaluate` body is pulled out into `evalBody` (truncated) so the eval-equiv
 * classification in MUTATION-TELEMETRY-SPEC.md has something to grade, and the
 * remaining args are stringified-and-truncated into `args`.
 */
function buildRecord({ ts, tool, ok, ms, args, sessionId, maxArgsChars, maxEvalBodyChars }) {
  const a = args && typeof args === "object" ? args : {};
  const isEval = tool === "evaluate";
  const rec = {
    ts,
    tool,
    ok,
    ms,
    targetUser: typeof a.targetUser === "string" ? a.targetUser : null,
    isEval,
    argKeys: Object.keys(a),
  };
  if (sessionId) rec.sessionId = sessionId;
  if (isEval && typeof a.expression === "string") {
    rec.evalBody = truncate(a.expression, maxEvalBodyChars);
  }
  // Preview of the remaining args (the big eval expression is captured above).
  const preview = { ...a };
  delete preview.expression;
  rec.args = truncate(safeStringify(preview), maxArgsChars);
  return rec;
}

function defaultAppendLine(path, line) {
  // O_APPEND; the caller serializes calls through a promise chain so concurrent
  // tool invocations can't interleave a partial line.
  return appendFile(path, `${line}\n`, "utf8");
}

/**
 * Create an isolated usage tracker. The module exports a singleton built from
 * config below; tests build their own with injected `now`/`appendLine`.
 *
 * @param {object}   [opts]
 * @param {boolean}  [opts.enabled=true]
 * @param {string}   [opts.logPath]
 * @param {() => Date} [opts.now]            clock (injectable for tests)
 * @param {(path:string, line:string) => Promise<void>} [opts.appendLine]
 * @param {number}   [opts.maxArgsChars=1000]
 * @param {number}   [opts.maxEvalBodyChars=2000]
 * @param {(err:any) => void} [opts.onError]  sink for append/record failures
 */
export function createUsageTracker({
  enabled = true,
  logPath = DEFAULT_LOG_PATH,
  now = () => new Date(),
  appendLine = defaultAppendLine,
  maxArgsChars = 1000,
  maxEvalBodyChars = 2000,
  onError = () => {},
} = {}) {
  const aggregates = new Map(); // tool → { count, errors, totalMs, firstUsed, lastUsed }
  const startedAt = now().toISOString();
  let totalCalls = 0;
  let totalErrors = 0;
  // Serialize disk appends so lines never interleave. Errors are swallowed into
  // onError — telemetry must never break a tool call.
  let writeChain = Promise.resolve();

  function record({ tool, ok = true, ms = 0, args, sessionId } = {}) {
    if (!enabled || !tool) return;
    try {
      const ts = now().toISOString();
      let agg = aggregates.get(tool);
      if (!agg) {
        agg = { count: 0, errors: 0, totalMs: 0, firstUsed: ts, lastUsed: ts };
        aggregates.set(tool, agg);
      }
      agg.count += 1;
      agg.totalMs += Number.isFinite(ms) ? ms : 0;
      agg.lastUsed = ts;
      if (!ok) agg.errors += 1;
      totalCalls += 1;
      if (!ok) totalErrors += 1;

      const line = JSON.stringify(
        buildRecord({ ts, tool, ok, ms, args, sessionId, maxArgsChars, maxEvalBodyChars })
      );
      writeChain = writeChain
        .then(() => appendLine(logPath, line))
        .catch((err) => onError(err));
    } catch (err) {
      onError(err);
    }
  }

  /**
   * Wrap a tool callback so each invocation is timed and recorded. Preserves
   * the SDK's (params, extra) call shape and the original return/throw
   * behavior. Returns the callback untouched when telemetry is disabled.
   */
  function wrap(name, callback) {
    if (!enabled) return callback;
    return async (...callArgs) => {
      const params = callArgs[0];
      const extra = callArgs[1];
      const start = now().getTime();
      let ok = true;
      try {
        const result = await callback(...callArgs);
        // Most error paths reject (caught below); some tools instead return a
        // soft-error result with isError. Treat that as a failure too.
        if (result && result.isError) ok = false;
        return result;
      } catch (err) {
        ok = false;
        throw err;
      } finally {
        record({
          tool: name,
          ok,
          ms: now().getTime() - start,
          args: params,
          sessionId: extra?.sessionId,
        });
      }
    };
  }

  function snapshot() {
    const tools = [...aggregates.entries()]
      .map(([tool, a]) => ({
        tool,
        count: a.count,
        errors: a.errors,
        errorRate: a.count ? Number((a.errors / a.count).toFixed(4)) : 0,
        avgMs: a.count ? Math.round(a.totalMs / a.count) : 0,
        firstUsed: a.firstUsed,
        lastUsed: a.lastUsed,
      }))
      .sort((x, y) => y.count - x.count || x.tool.localeCompare(y.tool));
    return {
      enabled,
      logPath,
      startedAt,
      totalCalls,
      totalErrors,
      distinctTools: tools.length,
      tools,
    };
  }

  // Resolve once all queued appends have flushed — only needed by tests.
  function flush() {
    return writeChain;
  }

  function reset() {
    aggregates.clear();
    totalCalls = 0;
    totalErrors = 0;
  }

  return {
    record,
    wrap,
    snapshot,
    flush,
    reset,
    get enabled() { return enabled; },
    get logPath() { return logPath; },
  };
}

// --- Singleton wired to config -------------------------------------------
const tracker = createUsageTracker({
  enabled: USAGE_TELEMETRY.enabled,
  logPath: USAGE_TELEMETRY.logPath || DEFAULT_LOG_PATH,
  maxArgsChars: USAGE_TELEMETRY.maxArgsChars,
  maxEvalBodyChars: USAGE_TELEMETRY.maxEvalBodyChars,
  onError: (err) => log(`usage-telemetry: ${err?.message || err}`),
});

export function wrapToolHandler(name, callback) {
  return tracker.wrap(name, callback);
}

export function getUsageSnapshot() {
  return tracker.snapshot();
}

export function getUsageLogPath() {
  return tracker.logPath;
}

export function isUsageTelemetryEnabled() {
  return tracker.enabled;
}
