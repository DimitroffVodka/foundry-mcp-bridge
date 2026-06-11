import test from "node:test";
import assert from "node:assert/strict";

import {
  createEvaluateHandler,
  createJobResultHandler,
} from "../tools/runtime.js";

test("evaluate forwards a clamped per-call timeout without sending it to Foundry", async () => {
  const calls = [];
  const handler = createEvaluateHandler(async (...args) => {
    calls.push(args);
    return { content: [] };
  });

  await handler({
    expression: "return 42;",
    targetUser: "Gamemaster",
    timeoutMs: 999_999,
  });

  assert.deepEqual(calls, [[
    "evaluate",
    { expression: "return 42;" },
    "Gamemaster",
    180_000,
  ]]);
});

test("evaluate preserves the default RPC timeout when timeoutMs is omitted", async () => {
  const calls = [];
  const handler = createEvaluateHandler(async (...args) => {
    calls.push(args);
    return { content: [] };
  });

  await handler({ expression: "return true;" });

  assert.deepEqual(calls, [[
    "evaluate",
    { expression: "return true;" },
    undefined,
    undefined,
  ]]);
});

test("evaluate forwards background mode to the bridge", async () => {
  const calls = [];
  const handler = createEvaluateHandler(async (...args) => {
    calls.push(args);
    return { content: [] };
  });

  await handler({ expression: "return 1;", background: true });

  assert.deepEqual(calls[0][1], {
    expression: "return 1;",
    background: true,
  });
});

test("job_result allows enough RPC time for its bounded wait", async () => {
  const calls = [];
  const handler = createJobResultHandler(async (...args) => {
    calls.push(args);
    return { content: [] };
  });

  await handler({
    jobId: "job-1",
    waitMs: 10_000,
    offset: 20,
    length: 100,
    delete: false,
    targetUser: "Gamemaster",
  });

  assert.deepEqual(calls, [[
    "job_result",
    { jobId: "job-1", waitMs: 10_000, offset: 20, length: 100, delete: false },
    "Gamemaster",
    15_000,
  ]]);
});
