# Debugging & investigation recipes

The MCP exposes investigation **primitives**, not monolithic "debug this" commands.
The capability is there; the friction is knowing which hooks to watch — and
Foundry's `Hooks.on` has **no wildcard matching** (`midi-qol.*` does not work), so
you must name hooks exactly. This file is the lookup table. The `trace_workflow`
tool bakes these same lists into named presets (see [Presets](#presets)).

> Hook names below track **Midi-QOL v13** (the v11+ workflow-state-machine
> refactor) and **dnd5e v4** activities. Source:
> <https://gitlab.com/tposney/midi-qol> README hook reference. If a world runs an
> older Midi, confirm names with `trace_hooks` on a single known hook first.

## The investigation loop

1. **snapshot** the actor(s) — `snapshot_actors({actors, select, storeId})`.
   Selectors walk the *live* document, so Active-Effect-modified derived stats
   (`system.attributes.ac.value`, `system.attributes.hp.max`, `statuses`) surface
   correctly — unlike `actor.toObject()`.
2. **trace** the action — `trace_hooks({hooks, until, timeoutMs})` for a
   time-ordered `{at, dt, hook, args}` timeline.
3. **trigger** the action (in a concurrent call, or via `trace_workflow`'s
   `trigger`).
4. **diff** — `diff_with({storeId})` re-snapshots and returns per-path
   `{path, op, before, after}`.

`trace_workflow` collapses steps 1–4 into one call.

## Scenario → hooks

### Follow a complete Midi-QOL workflow after a roll
Preset **`midi-full`**, terminal hook `midi-qol.RollComplete`:

```
midi-qol.preItemRoll, midi-qol.preTargeting, midi-qol.preAttackRoll,
midi-qol.AttackRollComplete, midi-qol.preCheckHits, midi-qol.hitsChecked,
midi-qol.preDamageRoll, midi-qol.DamageRollComplete,
midi-qol.preTargetDamageApplication, midi-qol.damaged, midi-qol.healed,
midi-qol.preApplyDynamicEffects, midi-qol.postActiveEffects, midi-qol.RollComplete
```

Most workflow-state hooks also have `pre<State>`/`post<State>` siblings
(`preWaitForAttackRoll`/`postWaitForAttackRoll`, `preSavesComplete`/
`postSavesComplete`, `preCleanup`/`postCleanup`, …). The arg to almost all of
them is the **workflow object**; `preTargetDamageApplication`/`damaged`/`healed`
receive `(token, {item, workflow, damageItem})`.

### Determine which hook modified a value
Preset **`document-lifecycle`**. Watch the value with `snapshot_actors`, trace
`preUpdateActor, updateActor, updateItem, applyActiveEffect, createChatMessage`,
then correlate the diff against the timeline `dt` ordering. The hook firing
immediately before the value settles is your culprit.

### Identify which Active Effect applied a change
Preset **`active-effect`**. `get_active_effects` lists what's *on* the actor;
trace `applyActiveEffect` (fires once per changed key with the effect + change in
args) plus the Midi `preApplyDynamicEffects`/`postActiveEffects` pair to see
application ordering. Snapshot `effects[*].name`, `statuses`, and the affected
derived stat.

### Determine which module is responsible for a behavior
**Heuristic, not exact** — Foundry does not tag document writes with an
originating module. Combine:
- `list_modules({activeOnly:false})` + `get_settings` per suspect.
- `trace_hooks` and look for a module-namespaced hook (`<module-id>.*`) in the timeline.
- `trace_socket` — modules that sync via `game.socket` emit `module.<id>` events.
A write that goes through a core hook with no module namespace is **not
attributable** by this method; say so rather than guessing.

### Compare an actor's state before and after an action
`snapshot_actors({storeId:"pre"})` → action → `diff_with({storeId:"pre"})`. Or
one-shot with `trace_workflow({preset, watch})`. Or `audit:true` on any single
mutating tool.

### Automatically observe changes produced by a macro
`get_macro` to read source → snapshot → run it (`evaluate`, or `click` if
UI-driven) → `diff_with`. Add `trace_workflow({preset:"document-lifecycle", watch})`
to catch hook-level writes during execution.

### Trace modifications during a gameplay sequence
Long window: `trace_hooks({hooks:[…], count:500, timeoutMs:30000})` plus
`snapshot_actors({storeId:"session-start"})` at the top and `diff_with` whenever
you want a delta. `get_console_errors` catches warnings from the same window.

### Core dnd5e world (no Midi-QOL)
Preset **`dnd5e-roll`**: `dnd5e.preUseActivity, dnd5e.preRollAttackV2,
dnd5e.rollAttackV2, dnd5e.preRollDamageV2, dnd5e.rollDamageV2,
dnd5e.preApplyDamage, dnd5e.applyDamage, dnd5e.postUseActivity`.

## Presets

`trace_workflow({preset, watch?, trigger?, …})` expands a preset into its hook
list, opens the window, and (with `watch`) returns a before/after diff next to
the timeline. Presets live in
[`server/lib/workflow-presets.js`](../server/lib/workflow-presets.js) — add
scenarios there.

| Preset | Closes | Terminal hook |
|---|---|---|
| `midi-full` | full Midi workflow | `midi-qol.RollComplete` |
| `midi-damage` | damage sub-flow | `midi-qol.RollComplete` |
| `active-effect` | AE application | — |
| `document-lifecycle` | which hook wrote a value | — |
| `dnd5e-roll` | non-Midi worlds | `dnd5e.postUseActivity` |

### Example — trace a Midi attack and see the HP change in one call

```jsonc
trace_workflow({
  "preset": "midi-full",
  "watch":  ["Goblin"],
  "trigger": {
    "tool": "use_item",                 // MUST be use_item for Midi presets — it
    "params": { "actor": "Sassafrass", "item": "Longsword" }  // calls item.use(),
  }                                      // which Midi patches. request_item_use
})                                       // bypasses Midi (no midi-qol.* hooks).
// → { preset, hooks, timeline:[{dt,hook,args}…], diff:[{path:"system.attributes.hp.value", before:7, after:1}], summary }
```

> **Trigger gotcha (verified on Midi v14).** `request_item_use` runs a direct
> attack/damage dispatcher that *bypasses* Midi-QOL entirely — useful for
> deterministic combat, useless for tracing a Midi workflow (zero `midi-qol.*`
> hooks fire). Always trigger Midi presets with `use_item`. Also: Midi must be
> set to auto-roll (`ConfigSettings.gmAutoAttack` / `gmAutoDamage` / `autoCheckHit`
> / `autoApplyDamage`), or `item.use()` parks at the manual attack-roll step and
> the trace captures only `preTargeting` + `preItemRoll` before timing out.

> **Concurrency note.** `trace_workflow` fires `trigger` ~150ms after opening the
> window (`triggerDelayMs`) so listeners are live first. If a workflow's first
> hook is missed, raise `triggerDelayMs`. If you trigger the action by other
> means (a second connected user, manual click), omit `trigger` and run the
> action while the window is open.
