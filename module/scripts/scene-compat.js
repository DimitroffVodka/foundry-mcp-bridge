const BACKGROUND_FIELDS = ["color", "src", "tint", "alphaThreshold"];
const TEXTURE_FIELDS = [
  "anchorX",
  "anchorY",
  "offsetX",
  "offsetY",
  "fit",
  "scaleX",
  "scaleY",
  "rotation",
];
const FOREGROUND_FIELDS = ["src", "tint", "alphaThreshold"];
const LEVEL_FOG_FIELDS = ["src", "tint"];

function asBackgroundObject(value) {
  if (typeof value === "string") return { src: value };
  return value && typeof value === "object" ? value : null;
}

function copyDotted(target, prefix, source, fields) {
  if (!source || typeof source !== "object") return;
  for (const field of fields) {
    if (field in source) target[`${prefix}.${field}`] = source[field];
  }
}

export function splitSceneCompatibilityFields(params, generation) {
  const sceneUpdate = {};
  const levelUpdate = {};
  const isV14 = Number(generation) >= 14;

  if (!isV14) {
    if ("backgroundColor" in params) sceneUpdate.backgroundColor = params.backgroundColor;
    if ("background" in params) sceneUpdate.background = asBackgroundObject(params.background);
    if ("foreground" in params) sceneUpdate.foreground = params.foreground;
    if ("fogExploration" in params) sceneUpdate.fogExploration = params.fogExploration;
    if ("fog" in params) sceneUpdate.fog = params.fog;
    if ("levelFog" in params) {
      throw new Error("`levelFog` requires Foundry v14 or later");
    }
    return { sceneUpdate, levelUpdate };
  }

  const background = asBackgroundObject(params.background);
  copyDotted(levelUpdate, "background", background, BACKGROUND_FIELDS);
  copyDotted(levelUpdate, "textures", background, TEXTURE_FIELDS);
  if ("backgroundColor" in params) levelUpdate["background.color"] = params.backgroundColor;
  copyDotted(levelUpdate, "foreground", params.foreground, FOREGROUND_FIELDS);
  copyDotted(levelUpdate, "fog", params.levelFog, LEVEL_FOG_FIELDS);

  if ("fog" in params) {
    sceneUpdate.fog = params.fog;
  } else if ("fogExploration" in params) {
    sceneUpdate["fog.mode"] = params.fogExploration ? 1 : 0;
  }

  return { sceneUpdate, levelUpdate };
}

export function resolveSceneLevel(scene) {
  const levels = scene?.levels;
  if (!levels) return null;
  const defaultLevel = levels.get?.("defaultLevel0000");
  if (defaultLevel) return defaultLevel;
  const initialId = typeof scene.initialLevel === "string"
    ? scene.initialLevel
    : scene.initialLevel?.id;
  if (initialId) {
    const initialLevel = levels.get?.(initialId);
    if (initialLevel) return initialLevel;
  }
  return levels.contents?.[0]
    ?? (typeof levels.values === "function" ? [...levels.values()][0] : null)
    ?? null;
}

export async function applySceneLevelUpdate(scene, levelUpdate) {
  if (!levelUpdate || Object.keys(levelUpdate).length === 0) return null;
  const level = resolveSceneLevel(scene);
  if (!level) {
    throw new Error(`Scene "${scene?.name ?? scene?.id ?? "unknown"}" has no Level document`);
  }
  await level.update(levelUpdate);
  return level;
}
