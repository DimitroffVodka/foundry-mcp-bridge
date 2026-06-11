const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_INLINE_BYTES = 256 * 1024;
const DEFAULT_MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 50;
const DEFAULT_MAX_RUNNING = 10;
const DEFAULT_MAX_CHUNK_CHARS = 64 * 1024;
const DEFAULT_PREVIEW_CHARS = 2_000;

function jsonBytes(text) {
  return new TextEncoder().encode(text).byteLength;
}

function publicTime(value) {
  return value ? new Date(value).toISOString() : null;
}

export function createRuntimeJobStore(options = {}) {
  const {
    ttlMs = DEFAULT_TTL_MS,
    inlineBytes = DEFAULT_INLINE_BYTES,
    maxEntryBytes = DEFAULT_MAX_ENTRY_BYTES,
    maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
    maxEntries = DEFAULT_MAX_ENTRIES,
    maxRunning = DEFAULT_MAX_RUNNING,
    maxChunkChars = DEFAULT_MAX_CHUNK_CHARS,
    previewChars = DEFAULT_PREVIEW_CHARS,
    now = () => Date.now(),
    randomId = () => crypto.randomUUID(),
  } = options;
  const records = new Map();

  const settledRecords = () => [...records.values()]
    .filter(record => record.status !== "running")
    .sort((a, b) => a.accessedAt - b.accessedAt);

  function totalStoredBytes() {
    let total = 0;
    for (const record of records.values()) total += record.totalBytes || 0;
    return total;
  }

  function prune() {
    const current = now();
    for (const [id, record] of records) {
      if (record.status === "running") continue;
      if (current - record.settledAt > ttlMs) records.delete(id);
    }
  }

  function makeRoom(extraBytes = 0, reservedId = null) {
    prune();
    const effectiveSize = () => records.size - (reservedId && records.has(reservedId) ? 1 : 0);
    for (const record of settledRecords().filter(entry => entry.id !== reservedId)) {
      if (effectiveSize() < maxEntries && totalStoredBytes() + extraBytes <= maxTotalBytes) break;
      records.delete(record.id);
    }
    if (effectiveSize() >= maxEntries) {
      throw new Error(`Job store is full (${maxEntries} entries)`);
    }
    if (totalStoredBytes() + extraBytes > maxTotalBytes) {
      throw new Error(`Job store byte limit exceeded (${maxTotalBytes} bytes)`);
    }
  }

  function serialize(value) {
    const text = JSON.stringify(value);
    if (text === undefined) throw new Error("Evaluation result is not JSON-serializable");
    const totalBytes = jsonBytes(text);
    if (totalBytes > maxEntryBytes) {
      throw new Error(`Evaluation result exceeds the ${maxEntryBytes}-byte storage limit`);
    }
    return { text, totalBytes };
  }

  function settle(record, value) {
    try {
      const { text, totalBytes } = serialize(value);
      makeRoom(totalBytes, record.id);
      record.status = "complete";
      record.serialized = text;
      record.totalBytes = totalBytes;
      record.settledAt = now();
      record.accessedAt = record.settledAt;
    } catch (err) {
      record.status = "error";
      record.error = err?.message || String(err);
      record.stack = err?.stack || null;
      record.settledAt = now();
      record.accessedAt = record.settledAt;
    }
  }

  function fail(record, err) {
    record.status = "error";
    record.error = err?.message || String(err);
    record.stack = err?.stack || null;
    record.settledAt = now();
    record.accessedAt = record.settledAt;
  }

  function createRecord(reservedBytes = 0) {
    makeRoom(reservedBytes);
    const id = randomId();
    const startedAt = now();
    const record = {
      id,
      status: "running",
      startedAt,
      settledAt: null,
      accessedAt: startedAt,
      serialized: null,
      totalBytes: 0,
      error: null,
      stack: null,
      promise: null,
    };
    records.set(id, record);
    return record;
  }

  function start(task) {
    prune();
    const running = [...records.values()].filter(record => record.status === "running").length;
    if (running >= maxRunning) {
      throw new Error(`Too many background jobs are running (${maxRunning} maximum)`);
    }
    const record = createRecord();
    record.promise = Promise.resolve()
      .then(task)
      .then(value => settle(record, value))
      .catch(err => fail(record, err));
    return {
      jobId: record.id,
      status: "running",
      startedAt: publicTime(record.startedAt),
    };
  }

  function formatImmediate(value) {
    const { text, totalBytes } = serialize(value);
    if (totalBytes <= inlineBytes) return value;

    const record = createRecord(totalBytes);
    record.status = "complete";
    record.serialized = text;
    record.totalBytes = totalBytes;
    record.settledAt = now();
    record.accessedAt = record.settledAt;
    return {
      resultHandle: record.id,
      status: "complete",
      totalBytes,
      totalChars: text.length,
      preview: text.slice(0, previewChars),
    };
  }

  async function read({
    jobId,
    waitMs = 0,
    offset = 0,
    length = maxChunkChars,
    delete: deleteRecord = false,
  }) {
    prune();
    const record = records.get(jobId);
    if (!record) return { error: `Unknown or expired job "${jobId}"` };
    record.accessedAt = now();

    if (deleteRecord) {
      if (record.status === "running") {
        return {
          jobId,
          status: "running",
          error: "Running JavaScript cannot be canceled safely; wait for settlement before deleting this job.",
        };
      }
      records.delete(jobId);
      return { jobId, deleted: true };
    }

    if (record.status === "running" && waitMs > 0) {
      await Promise.race([
        record.promise,
        new Promise(resolve => setTimeout(resolve, Math.max(0, waitMs))),
      ]);
    }

    if (record.status === "running") {
      return {
        jobId,
        status: "running",
        startedAt: publicTime(record.startedAt),
      };
    }
    if (record.status === "error") {
      return {
        jobId,
        status: "error",
        error: record.error,
        stack: record.stack,
        startedAt: publicTime(record.startedAt),
        settledAt: publicTime(record.settledAt),
      };
    }

    const boundedOffset = Math.max(0, Math.trunc(offset));
    const boundedLength = Math.min(Math.max(1, Math.trunc(length)), maxChunkChars);
    if (record.totalBytes <= inlineBytes && boundedOffset === 0) {
      return {
        jobId,
        status: "complete",
        result: JSON.parse(record.serialized),
        totalBytes: record.totalBytes,
        startedAt: publicTime(record.startedAt),
        settledAt: publicTime(record.settledAt),
      };
    }

    const chunk = record.serialized.slice(boundedOffset, boundedOffset + boundedLength);
    const nextOffset = boundedOffset + chunk.length;
    return {
      jobId,
      status: "complete",
      encoding: "json",
      chunk,
      offset: boundedOffset,
      nextOffset,
      totalChars: record.serialized.length,
      totalBytes: record.totalBytes,
      done: nextOffset >= record.serialized.length,
      startedAt: publicTime(record.startedAt),
      settledAt: publicTime(record.settledAt),
    };
  }

  return {
    start,
    formatImmediate,
    read,
    prune,
    get size() { return records.size; },
  };
}
