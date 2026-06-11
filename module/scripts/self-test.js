import {
  applySceneLevelUpdate,
  splitSceneCompatibilityFields
} from "./scene-compat.js";

function errorText(err) {
  return err?.message || String(err);
}

export async function runFoundrySelfTest(options = {}) {
  const gameRef = options.gameRef ?? globalThis.game;
  const createActor = options.createActor ?? (data => globalThis.Actor.create(data));
  const createJournal = options.createJournal ?? (data => globalThis.JournalEntry.create(data));
  const createTable = options.createTable ?? (data => globalThis.RollTable.create(data));
  const createScene = options.createScene ?? (data => globalThis.Scene.create(data));
  const randomId = options.randomId ?? (() => crypto.randomUUID());
  const generation = Number(gameRef?.release?.generation ?? 0);
  const runId = `foundry-mcp-self-test-${randomId()}`;
  const flags = { "foundry-mcp-live": { selfTestRun: runId } };
  const created = [];
  const checks = [];
  const cleanup = [];

  const collectionFor = kind => ({
    actor: gameRef.actors,
    journal: gameRef.journal,
    table: gameRef.tables,
    scene: gameRef.scenes,
  })[kind];

  async function check(name, fn) {
    try {
      const details = await fn();
      checks.push({ name, pass: true, details });
      return details;
    } catch (err) {
      checks.push({ name, pass: false, error: errorText(err) });
      return null;
    }
  }

  try {
    await check("actor-create", async () => {
      const actorType = gameRef?.system?.documentTypes?.Actor?.[0]
        ?? Object.keys(gameRef?.model?.Actor ?? {})[0];
      if (!actorType) throw new Error("Active system exposes no Actor document type");
      const actor = await createActor({ name: `${runId}-actor`, type: actorType, flags });
      if (!actor) throw new Error("Actor.create returned no document");
      created.push({ kind: "actor", doc: actor });
      if (actor.name !== `${runId}-actor`) throw new Error("Actor name did not round-trip");
      if (actor.type !== actorType) throw new Error("Actor type did not round-trip");
      if (actor.getFlag("foundry-mcp-live", "selfTestRun") !== runId) {
        throw new Error("Actor run flag did not round-trip");
      }
      return { id: actor.id, type: actor.type };
    });

    await check("journal-page-content", async () => {
      const content = `<p>${runId}</p>`;
      const journal = await createJournal({
        name: `${runId}-journal`,
        flags,
        pages: [{
          name: "Self Test Page",
          type: "text",
          text: { content, format: 1 },
          flags,
        }],
      });
      if (!journal) throw new Error("JournalEntry.create returned no document");
      created.push({ kind: "journal", doc: journal });
      const page = journal.pages?.contents?.[0];
      if (page?.text?.content !== content) throw new Error("Journal page content did not round-trip");
      return { id: journal.id, pageId: page?.id ?? null };
    });

    await check("table-result-description", async () => {
      const table = await createTable({
        name: `${runId}-table`,
        formula: "1d1",
        flags,
        results: [{
          type: "text",
          name: "Self Test Result",
          description: runId,
          range: [1, 1],
          weight: 1,
          flags,
        }],
      });
      if (!table) throw new Error("RollTable.create returned no document");
      created.push({ kind: "table", doc: table });
      const result = table.results?.contents?.[0];
      if (result?.description !== runId) throw new Error("TableResult.description did not round-trip");
      return { id: table.id, resultId: result?.id ?? null };
    });

    await check("scene-level-fields", async () => {
      const compatibility = splitSceneCompatibilityFields({
        backgroundColor: "#123456",
        background: { offsetX: 17, offsetY: 19 },
        fogExploration: false,
      }, generation);
      const scene = await createScene({
        name: `${runId}-scene`,
        width: 1000,
        height: 1000,
        padding: 0,
        grid: { type: 1, size: 100, alpha: 0.2 },
        flags,
        ...compatibility.sceneUpdate,
      });
      if (!scene) throw new Error("Scene.create returned no document");
      created.push({ kind: "scene", doc: scene });
      const level = await applySceneLevelUpdate(scene, compatibility.levelUpdate);
      if (generation >= 14) {
        if (String(level?.background?.color ?? "").toLowerCase() !== "#123456") {
          throw new Error("Level background color did not round-trip");
        }
        if (level?.textures?.offsetX !== 17 || level?.textures?.offsetY !== 19) {
          throw new Error("Level texture offsets did not round-trip");
        }
      }
      return {
        id: scene.id,
        levelId: level?.id ?? null,
        generation,
      };
    });
  } finally {
    for (const entry of [...created].reverse()) {
      const { kind, doc } = entry;
      try {
        const flag = doc.getFlag("foundry-mcp-live", "selfTestRun");
        if (flag !== runId) {
          cleanup.push({
            kind,
            id: doc.id,
            deleted: false,
            error: `Run flag mismatch; expected "${runId}", got "${flag}"`,
          });
          continue;
        }
        await doc.delete();
        const residual = collectionFor(kind)?.get?.(doc.id) ?? null;
        if (residual) {
          cleanup.push({ kind, id: doc.id, deleted: false, error: "Document still exists after delete" });
        } else {
          cleanup.push({ kind, id: doc.id, deleted: true });
        }
      } catch (err) {
        cleanup.push({ kind, id: doc.id, deleted: false, error: errorText(err) });
      }
    }
  }

  return {
    runId,
    pass: checks.length === 4
      && checks.every(entry => entry.pass)
      && cleanup.length === created.length
      && cleanup.every(entry => entry.deleted),
    checks,
    cleanup,
  };
}
