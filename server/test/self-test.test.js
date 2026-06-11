import test from "node:test";
import assert from "node:assert/strict";

import { runFoundrySelfTest } from "../../module/scripts/self-test.js";

function createFakeEnvironment({ cleanupFlagMatches = true } = {}) {
  let nextId = 0;
  const deleted = [];
  const collections = {
    actors: new Map(),
    journal: new Map(),
    tables: new Map(),
    scenes: new Map(),
  };

  const makeDoc = (kind, data, collection, extras = {}) => {
    const id = `${kind}-${++nextId}`;
    const runId = data.flags["foundry-mcp-live"].selfTestRun;
    const doc = {
      id,
      name: data.name,
      type: data.type,
      ...extras,
      getFlag: () => cleanupFlagMatches ? runId : "wrong-run",
      delete: async () => {
        deleted.push(id);
        collection.delete(id);
      },
    };
    collection.set(id, doc);
    return doc;
  };

  class FakeColor {
    constructor(value) {
      this.value = value;
    }

    toString() {
      return this.value;
    }

    toJSON() {
      return this.value;
    }
  }

  const level = {
    id: "defaultLevel0000",
    background: { color: "#999999", src: null, tint: "#ffffff", alphaThreshold: 0.75 },
    textures: { offsetX: 0, offsetY: 0 },
    update: async patch => {
      for (const [path, value] of Object.entries(patch)) {
        const [root, key] = path.split(".");
        level[root][key] = path === "background.color"
          ? new FakeColor(value)
          : value;
      }
    },
  };

  const dependencies = {
    gameRef: {
      release: { generation: 14 },
      system: { documentTypes: { Actor: ["NPC"] } },
      actors: { get: id => collections.actors.get(id) },
      journal: { get: id => collections.journal.get(id) },
      tables: { get: id => collections.tables.get(id) },
      scenes: { get: id => collections.scenes.get(id) },
    },
    createActor: async data => makeDoc("actor", data, collections.actors),
    createJournal: async data => makeDoc("journal", data, collections.journal, {
      pages: { contents: [{ text: { content: data.pages[0].text.content } }] },
    }),
    createTable: async data => makeDoc("table", data, collections.tables, {
      results: { contents: [{ description: data.results[0].description }] },
    }),
    createScene: async data => makeDoc("scene", data, collections.scenes, {
      levels: { get: id => id === level.id ? level : null, contents: [level] },
      initialLevel: level.id,
    }),
    randomId: () => "fixed-run",
  };

  return { dependencies, collections, deleted };
}

test("self test round-trips representative fields and deletes every created document", async () => {
  const env = createFakeEnvironment();

  const result = await runFoundrySelfTest(env.dependencies);

  assert.equal(result.pass, true);
  assert.equal(result.checks.every(check => check.pass), true);
  assert.equal(result.cleanup.every(entry => entry.deleted), true);
  assert.equal(env.deleted.length, 4);
  assert.equal([...Object.values(env.collections)].every(collection => collection.size === 0), true);
});

test("self test refuses cleanup when a document no longer carries its run flag", async () => {
  const env = createFakeEnvironment({ cleanupFlagMatches: false });

  const result = await runFoundrySelfTest(env.dependencies);

  assert.equal(result.pass, false);
  assert.equal(result.cleanup.every(entry => entry.deleted === false), true);
  assert.match(result.cleanup[0].error, /run flag mismatch/i);
});
