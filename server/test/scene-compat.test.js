import test from "node:test";
import assert from "node:assert/strict";

import {
  applySceneLevelUpdate,
  resolveSceneLevel,
  splitSceneCompatibilityFields,
} from "../../module/scripts/scene-compat.js";

test("v14 scene compatibility fields map to Scene fog and Level texture data", () => {
  const result = splitSceneCompatibilityFields({
    backgroundColor: "#112233",
    background: {
      src: "map.webp",
      tint: "#abcdef",
      alphaThreshold: 0.4,
      anchorX: 0.2,
      anchorY: 0.3,
      offsetX: 11,
      offsetY: 13,
      fit: "contain",
      scaleX: 1.2,
      scaleY: 1.3,
      rotation: 7,
    },
    foreground: { src: "foreground.webp", tint: "#ffffff", alphaThreshold: 0.5 },
    levelFog: { src: "fog.webp", tint: "#010203" },
    fogExploration: false,
  }, 14);

  assert.deepEqual(result.sceneUpdate, { "fog.mode": 0 });
  assert.deepEqual(result.levelUpdate, {
    "background.color": "#112233",
    "background.src": "map.webp",
    "background.tint": "#abcdef",
    "background.alphaThreshold": 0.4,
    "textures.anchorX": 0.2,
    "textures.anchorY": 0.3,
    "textures.offsetX": 11,
    "textures.offsetY": 13,
    "textures.fit": "contain",
    "textures.scaleX": 1.2,
    "textures.scaleY": 1.3,
    "textures.rotation": 7,
    "foreground.src": "foreground.webp",
    "foreground.tint": "#ffffff",
    "foreground.alphaThreshold": 0.5,
    "fog.src": "fog.webp",
    "fog.tint": "#010203",
  });
});

test("v13 keeps legacy scene fields at the Scene level", () => {
  const result = splitSceneCompatibilityFields({
    backgroundColor: "#112233",
    background: "map.webp",
    foreground: { src: "foreground.webp" },
    fogExploration: true,
  }, 13);

  assert.deepEqual(result.sceneUpdate, {
    backgroundColor: "#112233",
    background: { src: "map.webp" },
    foreground: { src: "foreground.webp" },
    fogExploration: true,
  });
  assert.deepEqual(result.levelUpdate, {});
});

test("explicit v14 Scene fog config wins over the compatibility boolean", () => {
  const result = splitSceneCompatibilityFields({
    fogExploration: false,
    fog: { mode: 2, colors: { explored: "#111111" } },
  }, 14);

  assert.deepEqual(result.sceneUpdate, {
    fog: { mode: 2, colors: { explored: "#111111" } },
  });
});

test("resolveSceneLevel uses default id, then initialLevel, then first level", () => {
  const defaultLevel = { id: "defaultLevel0000" };
  assert.equal(resolveSceneLevel({
    levels: {
      get: id => id === "defaultLevel0000" ? defaultLevel : null,
      contents: [{ id: "other" }],
    },
  }), defaultLevel);

  const initial = { id: "upper" };
  assert.equal(resolveSceneLevel({
    initialLevel: "upper",
    levels: {
      get: id => id === "upper" ? initial : null,
      contents: [{ id: "first" }],
    },
  }), initial);

  const first = { id: "first" };
  assert.equal(resolveSceneLevel({
    levels: { get: () => null, contents: [first] },
  }), first);
});

test("applySceneLevelUpdate errors clearly when v14 has no level", async () => {
  await assert.rejects(
    () => applySceneLevelUpdate({ name: "Broken", levels: { get: () => null, contents: [] } }, { "background.src": "map.webp" }),
    /has no Level document/,
  );
});
