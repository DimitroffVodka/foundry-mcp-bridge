import test from "node:test";
import assert from "node:assert/strict";

import { createUsageTracker } from "../lib/usage-telemetry.js";

// A fixed clock keeps timestamps + durations deterministic. `stepClock` advances
// by a fixed amount each read so we can assert measured durations.
function fixedClock(iso = "2026-06-24T00:00:00.000Z") {
  const d = new Date(iso);
  return () => new Date(d.getTime());
}
function stepClock(startMs = 1000, stepMs = 5) {
  let t = startMs;
  return () => {
    const d = new Date(t);
    t += stepMs;
    return d;
  };
}

// Captures appended lines instead of writing to disk.
function captureSink() {
  const lines = [];
  const appendLine = (_path, line) => {
    lines.push(line);
    return Promise.resolve();
  };
  return { lines, appendLine };
}

test("record aggregates counts, errors, and avg duration; snapshot sorts by count", async () => {
  const { lines, appendLine } = captureSink();
  const t = createUsageTracker({ now: fixedClock(), appendLine });

  t.record({ tool: "get_actor", ok: true, ms: 10 });
  t.record({ tool: "get_actor", ok: true, ms: 30 });
  t.record({ tool: "get_actor", ok: false, ms: 20 });
  t.record({ tool: "move_token", ok: true, ms: 100 });
  await t.flush();

  const snap = t.snapshot();
  assert.equal(snap.totalCalls, 4);
  assert.equal(snap.totalErrors, 1);
  assert.equal(snap.distinctTools, 2);

  // get_actor (3 calls) sorts before move_token (1 call).
  assert.equal(snap.tools[0].tool, "get_actor");
  assert.equal(snap.tools[0].count, 3);
  assert.equal(snap.tools[0].errors, 1);
  assert.equal(snap.tools[0].errorRate, 0.3333);
  assert.equal(snap.tools[0].avgMs, 20); // (10+30+20)/3
  assert.equal(snap.tools[1].tool, "move_token");

  assert.equal(lines.length, 4);
});

test("evaluate calls capture a truncated body and exclude it from the args preview", async () => {
  const { lines, appendLine } = captureSink();
  const t = createUsageTracker({ now: fixedClock(), appendLine, maxEvalBodyChars: 8 });

  t.record({
    tool: "evaluate",
    ok: true,
    ms: 5,
    args: { expression: "return game.users.size;", targetUser: "Alice" },
  });
  await t.flush();

  const rec = JSON.parse(lines[0]);
  assert.equal(rec.tool, "evaluate");
  assert.equal(rec.isEval, true);
  assert.equal(rec.targetUser, "Alice");
  assert.equal(rec.evalBody, "return g…(+15)"); // truncated to 8 chars + suffix
  assert.ok(!rec.args.includes("expression"), "expression must not leak into args preview");
  assert.ok(rec.args.includes("Alice"));
  assert.deepEqual(rec.argKeys, ["expression", "targetUser"]);
});

test("non-eval calls record null targetUser and a bounded args preview", async () => {
  const { lines, appendLine } = captureSink();
  const t = createUsageTracker({ now: fixedClock(), appendLine, maxArgsChars: 12 });

  t.record({ tool: "create_token", ok: true, ms: 7, args: { actorName: "Goblin Warlord", x: 100, y: 200 } });
  await t.flush();

  const rec = JSON.parse(lines[0]);
  assert.equal(rec.isEval, false);
  assert.equal(rec.targetUser, null);
  assert.equal(rec.evalBody, undefined);
  assert.ok(rec.args.endsWith(")"), `expected truncation marker, got ${rec.args}`);
  assert.deepEqual(rec.argKeys, ["actorName", "x", "y"]);
});

test("a disabled tracker no-ops: wrap returns the original callback and nothing is recorded", async () => {
  const { lines, appendLine } = captureSink();
  const t = createUsageTracker({ enabled: false, now: fixedClock(), appendLine });

  const original = async () => "ok";
  assert.equal(t.wrap("get_actor", original), original, "wrap must return the same reference when disabled");

  t.record({ tool: "get_actor", ok: true, ms: 5 });
  await t.flush();

  const snap = t.snapshot();
  assert.equal(snap.enabled, false);
  assert.equal(snap.totalCalls, 0);
  assert.equal(lines.length, 0);
});

test("wrap times the call, records success, and returns the result", async () => {
  const { lines, appendLine } = captureSink();
  // 3 reads per wrapped call: start, ms-end, record-ts. step=5 → ms = 5.
  const t = createUsageTracker({ now: stepClock(1000, 5), appendLine });

  const handler = t.wrap("roll", async (params) => ({ content: [{ type: "text", text: `rolled ${params.formula}` }] }));
  const result = await handler({ formula: "1d20" });
  await t.flush();

  assert.deepEqual(result, { content: [{ type: "text", text: "rolled 1d20" }] });
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.tool, "roll");
  assert.equal(rec.ok, true);
  assert.equal(rec.ms, 5);
});

test("wrap records ok:false and rethrows when the handler throws", async () => {
  const { lines, appendLine } = captureSink();
  const t = createUsageTracker({ now: fixedClock(), appendLine });

  const handler = t.wrap("apply_damage", async () => { throw new Error("bridge closed"); });
  await assert.rejects(() => handler({ amount: 5 }), /bridge closed/);
  await t.flush();

  const rec = JSON.parse(lines[0]);
  assert.equal(rec.ok, false);
  assert.equal(t.snapshot().totalErrors, 1);
});

test("wrap treats a soft-error result (isError) as a failure", async () => {
  const { appendLine } = captureSink();
  const t = createUsageTracker({ now: fixedClock(), appendLine });

  const handler = t.wrap("scene", async () => ({ isError: true, content: [{ type: "text", text: "nope" }] }));
  await handler({ action: "activate" });
  await t.flush();

  assert.equal(t.snapshot().tools[0].errors, 1);
});

test("wrap forwards the SDK (params, extra) shape and captures sessionId", async () => {
  const { lines, appendLine } = captureSink();
  const t = createUsageTracker({ now: fixedClock(), appendLine });

  let seenExtra;
  const handler = t.wrap("get_scene", async (_params, extra) => { seenExtra = extra; return "ok"; });
  await handler({ id: "abc" }, { sessionId: "sess-42", requestId: "r1" });
  await t.flush();

  assert.equal(seenExtra.requestId, "r1");
  assert.equal(JSON.parse(lines[0]).sessionId, "sess-42");
});

test("append failures are swallowed into onError and never break recording", async () => {
  const errors = [];
  const failingAppend = () => Promise.reject(new Error("disk full"));
  const t = createUsageTracker({
    now: fixedClock(),
    appendLine: failingAppend,
    onError: (err) => errors.push(err),
  });

  assert.doesNotThrow(() => t.record({ tool: "get_actor", ok: true, ms: 1 }));
  await t.flush();

  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /disk full/);
  // The in-memory aggregate still updates even when the disk write fails.
  assert.equal(t.snapshot().totalCalls, 1);
});
