/**
 * Workflow trace presets — named bundles of hook names + snapshot hints for
 * common "what just happened?" investigations.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `trace_hooks` is a primitive: you hand it an explicit array of hook names
 * and it returns a time-ordered timeline. Foundry's `Hooks.on` has NO wildcard
 * matching — `Hooks.on("midi-qol.*", …)` listens for a hook literally named
 * "midi-qol.*", which never fires. So to trace a Midi-QOL workflow an agent has
 * to already know the ~12 exact, version-specific hook strings. That knowledge
 * is the real gap behind "the MCP can't do autonomous investigation."
 *
 * This registry encodes that knowledge once. `trace_workflow` looks a preset up
 * here and expands it into the hook list (+ a terminal `until` hook and a
 * suggested snapshot scope) so the agent issues ONE call instead of
 * remembering the hook chain.
 *
 * Hook names verified against the Midi-QOL v14.0.8 SOURCE (not just the README)
 * and a live end-to-end trace: the workflow fires its mid/post hooks via a
 * `callMidiHooks(...)` helper (preCheckHits, hitsChecked, AttackRollComplete,
 * DamageRollComplete, preCheckSaves, postCheckSaves, postActiveEffects,
 * RollComplete), the `pre*` hooks dynamically, and the post-damage hook as
 * `midi-qol.${"isDamaged"|"isHealed"}`. Core dnd5e + Foundry document hooks are
 * used for the system-level / lifecycle presets.
 *
 * Sources: installed module `midi-qol/midi-qol.js` (v14.0.8) + Foundry API
 * <https://foundryvtt.com/api/>. The v13 README named the post-damage hooks
 * "damaged"/"healed" — stale; v14 fires isDamaged/isHealed (verified live).
 *
 * Each preset:
 *   - hooks   : exact hook strings to register (order doesn't matter; the
 *               timeline is timestamped)
 *   - until   : hook that terminates the window early when it fires (the
 *               natural "workflow done" marker), or null
 *   - select  : default snapshot selectors for the `watch` actors, surfacing
 *               the fields this scenario usually mutates (derived data is
 *               walked live, so AE-modified stats show up)
 *   - blurb   : one-liner shown in the tool description / docs
 */

export const WORKFLOW_PRESETS = {
  // ---- Midi-QOL ----------------------------------------------------------
  "midi-full": {
    blurb: "Full Midi-QOL item-use lifecycle: targeting → attack → hit → damage → apply effects.",
    until: "midi-qol.RollComplete",
    select: ["system.attributes.hp.value", "system.attributes.hp.temp", "effects[*].name", "statuses"],
    hooks: [
      "midi-qol.preItemRoll",
      "midi-qol.preTargeting",
      "midi-qol.preAttackRoll",
      "midi-qol.AttackRollComplete",
      "midi-qol.preCheckHits",
      "midi-qol.hitsChecked",
      "midi-qol.preDamageRoll",
      "midi-qol.DamageRollComplete",
      "midi-qol.preTargetDamageApplication",
      // v14.0.8 source fires `midi-qol.${healedDamaged}` where healedDamaged is
      // "isDamaged" / "isHealed" — args (token, {item, workflow, damageItem, ditem}).
      // Older Midi/READMEs documented "damaged"/"healed"; those do NOT fire in v14.
      "midi-qol.isDamaged",
      "midi-qol.isHealed",
      "midi-qol.preApplyDynamicEffects",
      "midi-qol.postActiveEffects",
      "midi-qol.RollComplete",
    ],
  },

  "midi-damage": {
    blurb: "Midi-QOL damage sub-flow: damage roll → calculation → per-target application.",
    until: "midi-qol.RollComplete",
    select: ["system.attributes.hp.value", "system.attributes.hp.temp"],
    hooks: [
      "midi-qol.preDamageRoll",
      "midi-qol.DamageRollComplete",
      "midi-qol.dnd5ePreCalculateDamage",
      "midi-qol.dnd5eCalculateDamage",
      "midi-qol.preTargetDamageApplication",
      // v14.0.8 source fires `midi-qol.${healedDamaged}` where healedDamaged is
      // "isDamaged" / "isHealed" — args (token, {item, workflow, damageItem, ditem}).
      // Older Midi/READMEs documented "damaged"/"healed"; those do NOT fire in v14.
      "midi-qol.isDamaged",
      "midi-qol.isHealed",
      "midi-qol.RollComplete",
    ],
  },

  // ---- Active Effects ----------------------------------------------------
  "active-effect": {
    blurb: "Active Effect application lifecycle (Midi dynamic effects + core AE hooks).",
    until: null,
    select: ["effects[*].name", "effects[*].disabled", "statuses",
             "system.attributes.ac.value", "system.attributes.hp.max"],
    hooks: [
      "midi-qol.preApplyDynamicEffects",
      "midi-qol.postApplyDynamicEffects",
      "midi-qol.postActiveEffects",
      // core Foundry / dnd5e AE document hooks
      "preCreateActiveEffect",
      "createActiveEffect",
      "applyActiveEffect",
      "preUpdateActiveEffect",
      "updateActiveEffect",
      "preDeleteActiveEffect",
      "deleteActiveEffect",
    ],
  },

  // ---- Generic document writes ------------------------------------------
  "document-lifecycle": {
    blurb: "Generic document mutations on an actor — answers 'which hook wrote this value?'.",
    until: null,
    select: null, // full toObject() projection by default
    hooks: [
      "preUpdateActor",
      "updateActor",
      "preCreateItem",
      "createItem",
      "preUpdateItem",
      "updateItem",
      "preDeleteItem",
      "deleteItem",
      "applyActiveEffect",
      "createChatMessage",
    ],
  },

  // ---- Core dnd5e (no Midi-QOL) -----------------------------------------
  "dnd5e-roll": {
    blurb: "Core dnd5e activity/roll hooks for worlds NOT running Midi-QOL.",
    until: "dnd5e.postUseActivity",
    select: ["system.attributes.hp.value", "system.attributes.hp.temp"],
    hooks: [
      "dnd5e.preUseActivity",
      "dnd5e.preRollAttackV2",
      "dnd5e.rollAttackV2",
      "dnd5e.preRollDamageV2",
      "dnd5e.rollDamageV2",
      "dnd5e.preApplyDamage",
      "dnd5e.applyDamage",
      "dnd5e.postUseActivity",
      "createChatMessage",
    ],
  },
};

/** Sorted list of preset keys (for enum / error messages). */
export const PRESET_KEYS = Object.keys(WORKFLOW_PRESETS);

/** One-line "key — blurb" catalogue, embedded in the tool description. */
export function presetCatalogue() {
  return PRESET_KEYS.map(k => `'${k}' — ${WORKFLOW_PRESETS[k].blurb}`).join("\n  ");
}
