import test from "node:test";
import assert from "node:assert/strict";

import { createRuntimeJobStore } from "../../module/scripts/runtime-jobs.js";

test("background jobs return immediately and later expose their result", async () => {
  const store = createRuntimeJobStore({ randomId: () => "job-1" });
  let resolveTask;
  const task = new Promise(resolve => { resolveTask = resolve; });

  const started = store.start(() => task);
  assert.deepEqual(started, {
    jobId: "job-1",
    status: "running",
    startedAt: started.startedAt,
  });
  assert.equal((await store.read({ jobId: "job-1" })).status, "running");

  resolveTask({ result: 42, evalMs: 10 });
  await task;
  await new Promise(resolve => setTimeout(resolve, 0));

  const completed = await store.read({ jobId: "job-1" });
  assert.equal(completed.status, "complete");
  assert.deepEqual(completed.result, { result: 42, evalMs: 10 });
});

test("oversized results return a handle and can be read in chunks", async () => {
  const store = createRuntimeJobStore({
    inlineBytes: 32,
    maxChunkChars: 12,
    randomId: () => "result-1",
  });

  const immediate = store.formatImmediate({ result: "x".repeat(100), evalMs: 1 });
  assert.equal(immediate.status, "complete");
  assert.equal(immediate.resultHandle, "result-1");
  assert.equal(immediate.preview.length > 0, true);

  const first = await store.read({ jobId: "result-1", offset: 0, length: 12 });
  assert.equal(first.status, "complete");
  assert.equal(first.chunk.length, 12);
  assert.equal(first.nextOffset, 12);
  assert.equal(first.done, false);
});

test("completed jobs remain retryable until explicitly deleted", async () => {
  const store = createRuntimeJobStore({ inlineBytes: 1, randomId: () => "job-2" });
  store.formatImmediate({ result: "ok" });

  assert.equal((await store.read({ jobId: "job-2" })).status, "complete");
  assert.equal((await store.read({ jobId: "job-2" })).status, "complete");
  assert.deepEqual(await store.read({ jobId: "job-2", delete: true }), {
    jobId: "job-2",
    deleted: true,
  });
  assert.equal((await store.read({ jobId: "job-2" })).error, 'Unknown or expired job "job-2"');
});

test("running jobs cannot be deleted because execution cannot be canceled", async () => {
  const store = createRuntimeJobStore({ randomId: () => "job-3" });
  store.start(() => new Promise(() => {}));

  const result = await store.read({ jobId: "job-3", delete: true });
  assert.equal(result.status, "running");
  assert.match(result.error, /cannot be canceled/i);
});

test("job store rejects work beyond the concurrent running limit", () => {
  let id = 0;
  const store = createRuntimeJobStore({
    maxRunning: 1,
    randomId: () => `job-${++id}`,
  });
  store.start(() => new Promise(() => {}));

  assert.throws(
    () => store.start(() => Promise.resolve("second")),
    /Too many background jobs/,
  );
});

test("oversized immediate results evict old entries to stay within the total byte limit", async () => {
  let id = 0;
  const store = createRuntimeJobStore({
    inlineBytes: 1,
    maxEntryBytes: 100,
    maxTotalBytes: 80,
    randomId: () => `result-${++id}`,
  });

  store.formatImmediate("a".repeat(50));
  store.formatImmediate("b".repeat(50));

  assert.equal(store.size, 1);
  assert.match(
    (await store.read({ jobId: "result-1" })).error,
    /unknown or expired/i,
  );
  assert.equal((await store.read({ jobId: "result-2" })).status, "complete");
});

test("a background job can settle when it occupies the final entry slot", async () => {
  const store = createRuntimeJobStore({
    maxEntries: 1,
    randomId: () => "only-job",
  });

  store.start(() => "complete");
  await new Promise(resolve => setTimeout(resolve, 0));

  const result = await store.read({ jobId: "only-job" });
  assert.equal(result.status, "complete");
  assert.equal(result.result, "complete");
});
