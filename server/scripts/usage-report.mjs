#!/usr/bin/env node
/**
 * usage-report — turn the tool-usage telemetry JSONL into a decision-ready
 * report, so the "read the data, then prune/sharpen" step is one command.
 *
 * It reads the durable JSONL log (all-time history), NOT GET /api/usage — the
 * endpoint is the live, in-memory view that resets on every server restart,
 * whereas the JSONL accumulates across restarts and carries the eval bodies.
 *
 *   cd server && npm run report                 # default log path
 *   npm run report -- --evals                   # dump every evaluate body, full
 *   npm run report -- path/to/usage.jsonl       # explicit log file
 *   FOUNDRY_MCP_USAGE_LOG=… npm run report
 *
 * Three buckets, mapping straight onto the decision rule in
 * MUTATION-TELEMETRY-SPEC.md:
 *   USED        → leave alone.
 *   NEVER USED  → merge into an action-tool or cut — unless it's irreplaceable
 *                 (a Tier-4 tool evaluate can't reproduce) or opt-in infra.
 *   EVAL BODIES → eyeball them; an evaluate that a dedicated tool should have
 *                 done is a discoverability problem → sharpen that tool's desc.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const TOOLS_DIR = fileURLToPath(new URL("../tools/", import.meta.url));
const args = process.argv.slice(2);
const showAllEvals = args.includes("--evals");
const positional = args.filter((a) => !a.startsWith("--"));
const LOG_PATH =
  positional[0] ||
  process.env.FOUNDRY_MCP_USAGE_LOG ||
  fileURLToPath(new URL("../usage-telemetry.jsonl", import.meta.url));

// Tier-4 "genuinely cannot be evaluate" set from EVALUATE-REDUNDANCY.md. These
// reach something a client-side eval can't, so being rarely/never used is fine
// — NOT a signal to cut.
const IRREPLACEABLE = new Set([
  "bridge_status", "list_connected_bridges", "job_result", "reload_foundry",
  "screenshot", "diff_with", "trace_hooks", "trace_socket", "trace_workflow",
  "request_roll", "request_check", "request_item_use",
]);
// Opt-in infrastructure — only registered when its env flag is on, so absence
// from the log usually just means it isn't enabled here.
const CONDITIONAL = new Set(["self_test", "relaunch_client"]);

function registeredTools() {
  const re = /register(?:Routed|Raw|Merged)Tool\(\s*mcp\s*,\s*"([a-z_]+)"/g;
  const names = new Set();
  for (const f of readdirSync(TOOLS_DIR).filter((f) => f.endsWith(".js"))) {
    for (const m of readFileSync(TOOLS_DIR + f, "utf8").matchAll(re)) names.add(m[1]);
  }
  return names;
}

function loadRecords(path) {
  if (!existsSync(path)) return null;
  const recs = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try { recs.push(JSON.parse(s)); } catch { /* skip a partial/corrupt line */ }
  }
  return recs;
}

const pad = (s, n) => { s = String(s); return s + " ".repeat(Math.max(0, n - s.length)); };
const lpad = (s, n) => String(s).padStart(n);

function annotate(tool) {
  if (tool === "evaluate") return "good — power tool going unused";
  if (IRREPLACEABLE.has(tool)) return "keep — irreplaceable (Tier-4)";
  if (CONDITIONAL.has(tool)) return "opt-in infra (registered only when enabled)";
  return "merge/cut candidate";
}

const REG = registeredTools();
const records = loadRecords(LOG_PATH);

if (records === null) {
  console.log(`No usage log at ${LOG_PATH}`);
  console.log(`Telemetry writes one line per tool call once the server runs with the telemetry code.`);
  console.log(`If you just enabled it: restart the server, use a client, then re-run this.`);
  process.exit(0);
}
if (records.length === 0) {
  console.log(`Usage log ${LOG_PATH} is empty — no tool calls recorded yet.`);
  process.exit(0);
}

// --- Aggregate ----------------------------------------------------------
const stats = new Map(); // tool → { count, errors, totalMs, first, last }
const evalBodies = [];
let firstTs = records[0].ts || "";
let lastTs = records[0].ts || "";
for (const r of records) {
  if (!r || typeof r.tool !== "string") continue;
  let a = stats.get(r.tool);
  if (!a) { a = { count: 0, errors: 0, totalMs: 0, first: r.ts, last: r.ts }; stats.set(r.tool, a); }
  a.count++;
  if (r.ok === false) a.errors++;
  if (typeof r.ms === "number") a.totalMs += r.ms;
  if (r.ts) { if (r.ts < a.first) a.first = r.ts; if (r.ts > a.last) a.last = r.ts;
              if (r.ts < firstTs) firstTs = r.ts; if (r.ts > lastTs) lastTs = r.ts; }
  if (r.isEval && r.evalBody) evalBodies.push({ ts: r.ts, ok: r.ok, body: r.evalBody });
}

const total = records.length;
const evalCount = stats.get("evaluate")?.count || 0;
const evalSharePct = total ? (evalCount / total) * 100 : 0;

// --- Report -------------------------------------------------------------
console.log("");
console.log("Foundry MCP — tool usage report");
console.log(`  log:      ${LOG_PATH}`);
console.log(`  window:   ${firstTs}  →  ${lastTs}`);
console.log(`  calls:    ${total}    distinct tools used: ${stats.size}/${REG.size}`);
console.log(`  evaluate: ${evalSharePct.toFixed(1)}% of calls  (${evalCount} of ${total})`);
if (total < 100) {
  console.log("");
  console.log(`  ⚠ small sample (${total} calls). Treat NEVER USED as "not exercised yet", NOT`);
  console.log(`    "dead" — core tools just haven't run. Don't prune until a few hundred real`);
  console.log(`    calls accumulate. (The evaluate share + eval bodies are informative now, though.)`);
}
console.log("");

const used = [...stats.entries()].sort((a, b) => b[1].count - a[1].count);
console.log(`USED (${used.length})    tool                          count   err   avg`);
for (const [tool, a] of used) {
  console.log(`  ${pad(tool, 28)} ${lpad(a.count, 6)} ${lpad(a.errors, 5)}  ${lpad(Math.round(a.totalMs / a.count), 4)}ms`);
}
console.log("");

const never = [...REG].filter((t) => !stats.has(t)).sort();
const cutCandidates = never.filter((t) => annotate(t) === "merge/cut candidate").length;
console.log(`NEVER USED (${never.length}, of which ${cutCandidates} merge/cut candidates)`);
for (const t of never) console.log(`  ${pad(t, 28)} ${annotate(t)}`);
console.log("");

console.log(`EVALUATE bodies (${evalBodies.length}) — any that a dedicated tool should have done → sharpen that tool's description`);
const shown = showAllEvals ? evalBodies : evalBodies.slice(-25);
for (const e of shown) {
  const body = showAllEvals ? e.body : e.body.replace(/\s+/g, " ").slice(0, 140);
  console.log(`  [${e.ts}]${e.ok === false ? " ERR" : ""} ${body}`);
}
if (!showAllEvals && evalBodies.length > shown.length) {
  console.log(`  … and ${evalBodies.length - shown.length} earlier — rerun with --evals for all, full-length`);
}
console.log("");
