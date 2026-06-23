# Foundry MCP Tools — Detailed Reference

All tools route: MCP client → `server.js` (HTTP) → WebSocket → `bridge.js` (inside Foundry). Each connected Foundry tab registers its user identity with the server; tool calls route to the GM by default and can be targeted at any connected user via `targetUser`.

Token tools accept a `token` reference that can be the **document id**, the **token name**, or the **linked actor name** — `_findToken(scene, ref)` resolves in that order.

Actor/item/macro lookups by name require an **exact match** unless noted.

---

## Universal parameters

### `targetUser` (optional, every routed tool)

Every tool that proxies to the Foundry bridge accepts an optional `targetUser` parameter to route the call to a specific Foundry user. The bridge runs in that user's browser context, so the call sees what *they* see and runs with *their* permissions.

- **Omitted** / `"GM"` / `"self"` → routes to the GM (default).
- **A user name string** (e.g. `"Sassafrass"`, or the GM's actual user name like `"Gamemaster"`) → routes to that user's bridge.

If the named user isn't connected, the tool errors with `"No bridge connected for user 'X'. Connected: ..."` (the connected list helps you self-correct). Use `list_connected_bridges` to discover available targets.

**Why it matters:** testing module behavior from a player's perspective without losing the GM session. A GM-side `evaluate` won't surface permission-gated bugs the way a player-side one will.

### `audit` (optional, mutating tools only)

Every tool that modifies the Foundry world (creates, updates, or deletes documents) accepts an optional `audit: true` parameter. When set, the tool returns an `audit` block containing a flight recorder of the mutation.

- **`audit.before`** — snapshot of the affected document(s) *before* the change.
- **`audit.after`** — snapshot *after* the change.
- **`audit.diff`** — structured delta of what actually changed. Noisy metadata (timestamps, stats, IDs) is automatically filtered.
- **`audit.undo`** — dry instructions for how to revert the change (e.g. rollback data or a delete command).

**Efficiency Note:** Full snapshots are limited to 10 documents per call to keep context window usage low. If more are affected, the audit will note the truncation. Use this to self-verify your work in an **Act -> Validate** loop.

The server-local tools are `list_connected_bridges`, `bridge_status`,
`reload_foundry`, and the opt-in `relaunch_client`. They inspect or
orchestrate the bridge process directly instead of proxying a normal tool
call through Foundry.

## Write compatibility audit

The released module manifest currently requires Foundry v14. The v13 column
documents retained compatibility paths in the bridge; it is static-only and
is not a promise of full v13 module support.

| Write surface | Foundry v13 | Foundry v14 |
|---|---|---|
| Actors, embedded Items, folders, journals/pages, tokens, combat, chat, templates | Native document create/update/delete APIs | Same APIs; no schema translation required |
| Actor ownership | Friendly level names are resolved to numeric ownership levels before update | Same; avoids writing role names or raw user-facing labels into the document |
| Scene background/foreground/fog | Legacy Scene fields (`background`, `backgroundColor`, `foreground`, `fogExploration`) | `background`/`foreground`/level fog map to the default embedded Level; exploration maps to `Scene.fog.mode` |
| Scene Levels | Not available; level-only inputs error clearly | Native embedded `Level` CRUD |
| Regions | Passed through to the core Region schema | Passed through to the core Region schema, including level membership |
| RollTable results | No dedicated authoring tool; legacy `.text` is not written | `self_test` validates `TableResult.description` |
| Compendium configuration | No write tool calls `pack.configure`; label/ownership schema drift is therefore not exposed | Same |
| Snapshots/diffs | Read-only | Read-only |

The guarded `self_test` provides the runtime check for representative Actor,
JournalEntry/Page, RollTable/TableResult, and Scene/Level writes after a
Foundry core update.

---

## Game info

### `get_game_info`
Liveness check + environment snapshot. Use this first to confirm the bridge is responsive and to learn what system you're in.

- **Params**: none
- **Returns**:
  - `system` — `{ id, title, version }` of the game system module (e.g. `{id: "vagabond", version: "5.2.1"}`). Determines what fields exist on actors/items elsewhere.
  - `world` — `{ id, title }` of the loaded world.
  - `foundryVersion` — e.g. `"13.351"`. Use this to branch logic that differs across Foundry major versions.
  - `users` — `[{ name, role, active }]`. `role` is an integer: 0=None, 1=Player, 2=Trusted, 3=Assistant, 4=Gamemaster. `active: true` means connected right now.

  Note: `users` lists everyone logged in to Foundry, whether or not they have the `foundry-mcp-live` module connected. For the list of users actually reachable as a `targetUser`, use `list_connected_bridges`.

---

## Bridge discovery

### `list_connected_bridges`
List all Foundry users currently connected via the bridge module. Use the `targetUser` field directly as the `targetUser` parameter on other tools — it already handles host disambiguation when the same user name is connected from multiple worlds. The GM is the default target and need not be specified.

This is a **server-local** tool — it doesn't proxy through any bridge — so it works even when no bridges are connected (returns empty list).

- **Params**: none
- **Returns**:
  - `bridges` — array of `{ userId, userName, host, isGM, connectedAt, targetUser }`, sorted GM-first then alphabetical by `userName`.
    - `userName` — Foundry user name (e.g. `"Gamemaster"`).
    - `host` — the Foundry server this bridge came from (e.g. `"localhost:30000"`, `"shadowfoundry.online"`).
    - `targetUser` — the canonical routing value to pass to other tools. Equal to `userName` when unambiguous, or `userName@host` when the same name is connected from multiple worlds. `userId` is also accepted as an unambiguous escape hatch.
  - `legacyBridgeConnected` — `true` if a pre-multi-user bridge is also attached (only present when applicable). Indicates the user should upgrade their bridge module to address it by name.
  - `note` — when `legacyBridgeConnected` is set, a human-readable explanation.

### `bridge_status`
Diagnose the full connection chain even when no Foundry bridge is currently
connected. Combines current and last-seen bridge metadata with REST probes of
known Foundry `/api/status` endpoints.

- **Params**: none.
- **Returns**:
  - `classification` — one of `bridge-connected`,
    `foundry-up-no-bridge`, `foundry-up-no-users`, `foundry-down`, or
    `unknown`.
  - `bridges` — currently connected identified bridges.
  - `lastSeenBridges` — retained metadata from bridges seen since server start.
  - `probes` — REST status or error details for each known Foundry origin.
- **Restart-safe targets**: set `FOUNDRY_URLS` to a comma-separated list such
  as `http://localhost:30000,https://foundry.example.com`. This lets the server
  diagnose Foundry before any bridge has connected after a server restart.

### `reload_foundry`
Reload a targeted Foundry browser tab, wait for the same user bridge to
reconnect, then poll until `game.ready === true`.

- **Params**: `targetUser?`, `timeoutMs?` (default 30000).
- **Failure behavior**: routing and reconnect failures return the same
  structured diagnosis as `bridge_status`, alongside the reload error.

### `relaunch_client` (opt-in)
Recover from a discarded or closed GM browser tab by launching the explicitly
configured Chrome executable, opening `/join`, selecting the configured GM,
submitting the environment-only password, and waiting for the bridge.

- **Gate**: absent unless `FOUNDRY_RELAUNCH_ENABLED=1`.
- **Required config**: `FOUNDRY_RELAUNCH_URL`,
  `FOUNDRY_RELAUNCH_GM_USER`, and `FOUNDRY_CHROME_PATH`.
- **Optional config**: `FOUNDRY_RELAUNCH_GM_PASSWORD`,
  `FOUNDRY_CHROME_USER_DATA_DIR`, `FOUNDRY_RELAUNCH_ALLOW_REMOTE=1`, and
  `FOUNDRY_RELAUNCH_HEADLESS=1` — run the recovery client headless. A headless
  client has no GPU, so it also disables the Foundry canvas (`core.noCanvas`,
  pre-seeded before `/game` loads) and strips CSS animations, otherwise software
  WebGL (SwiftShader) pegs the CPU. Trade-off: a headless client can't serve
  canvas ops (`screenshot`, scene placeable coordinates) — route those to a
  canvas-enabled client.
- **Network policy**: the Foundry URL must use localhost, `127.0.0.1`, or
  `[::1]` unless remote relaunch is explicitly enabled.
- **Credential policy**: passwords are never accepted as tool parameters and
  are redacted from errors.
- **Params**: `timeoutMs?` (5000-120000, default 30000).
- **Already connected**: returns immediately without launching Chrome when
  the configured GM bridge is already present.

### Autonomous relaunch supervision (opt-in)
With `FOUNDRY_RELAUNCH_AUTO=1` the server watches for the configured GM bridge
dropping and invokes the same relaunch handler automatically — so a crashed or
closed tab recovers with no operator action (the "away from desk" case). It
shares the single relaunch handler with `relaunch_client`, so the supervisor and
the tool can never double-launch a browser.

- **Gate**: `FOUNDRY_RELAUNCH_AUTO=1`, plus a valid relaunch config
  (`FOUNDRY_RELAUNCH_ENABLED=1` + URL/GM/Chrome). If the config is invalid it
  logs why and stays idle.
- **Tuning**: `FOUNDRY_RELAUNCH_AUTO_INTERVAL_MS` (poll interval, default 15000)
  and `FOUNDRY_RELAUNCH_AUTO_MAX_BACKOFF_MS` (default 300000). A failed relaunch
  backs off exponentially up to the cap so a down Foundry can't trigger a
  Chrome-launch storm; backoff resets the moment the GM reconnects.

---

## Actors

### `list_actors`
Lightweight actor index — names and ids only. Use this to discover what's in the world before pulling full data.

- **Params**:
  - `type?` — filter by actor type. System-dependent; Vagabond uses `"character"` and `"npc"`.
  - `folder?` — filter by sidebar folder name (exact match).
- **Returns**: `[{ id, name, type, folder, img }]`
  - `folder` is `null` if the actor isn't in a folder.
  - `img` is the actor portrait URL (may be a relative path).

### `get_actor`
Full actor document (`actor.toObject()`). **Heavy** — includes all system data, every embedded item, every effect. Use `get_token_details` if you only need the in-scene token's data.

- **Params**: `id?` **or** `name?` (exact).
- **Returns**: raw actor document. Shape depends on system and actor type. Common top-level keys:
  - `_id, name, type, img, system, items, effects, prototypeToken, folder, sort, ownership, flags`
  - `system` contains all system-specific fields (hp, stats, skills…). See `get_data_model` for the schema.
  - `items` is an array of embedded item documents.
  - `effects` is an array of Active Effects.

### `get_selected_token`
The token the GM has selected on the canvas *right now*. Useful for "do this to whatever I'm pointing at" flows.

- **Params**: none
- **Returns**:
  - `{ token: {id, name, x, y, elevation}, actor }` where `actor` is `actor.toObject()` (full), or
  - `{ error: "No token selected" }` if nothing is selected.

### `get_active_effects`
Every Active Effect on an actor — buffs, debuffs, persistent item effects, status effects represented as AEs. This is more specific than `get_actor` (which also has them, nested).

- **Params**: `id?` **or** `name?`
- **Returns**: `[effect.toObject()]`. Each effect has:
  - `_id, name, icon, origin, disabled, duration, changes, statuses, flags, transfer`
  - `changes` — array of `{key, mode, value, priority}` that patches other fields when the effect is active.
  - `statuses` — ids of status conditions this effect applies (e.g. `["prone"]`).
  - `duration` — `{seconds, rounds, turns, startRound, startTurn, combat}` — combat-aware duration.
  - `disabled` — if true the effect exists but isn't applying.

---

## Modules

### `list_modules`
What modules are installed and active. Useful for verifying the bridge module itself is enabled, or checking prerequisites before trying something.

- **Params**: `activeOnly?` (default `true`)
- **Returns**: `[{ id, title, version, active }]`

---

## Compendiums

### `list_compendiums`
All installed compendium packs.

- **Params**: `type?` — filter by document type: `"Actor"`, `"Item"`, `"JournalEntry"`, `"RollTable"`, `"Scene"`, `"Macro"`, etc.
- **Returns**: `[{ id, label, type, system, count }]`
  - `id` is the collection path (e.g. `"vagabond.monsters"`) — use this as `pack` in subsequent tools.
  - `label` is the human-readable name shown in the sidebar.
  - `system` is non-null only if the pack is system-locked.
  - `count` is the number of entries in the pack's index.

### `search_compendium`
Name-substring search within one pack. Loads the index on demand.

- **Params**:
  - `pack` (required) — the pack id from `list_compendiums`.
  - `query?` — case-insensitive substring match against entry names. Omit to return all.
  - `full?` — if true **and result count ≤ 20**, returns full documents instead of index entries. Otherwise ignored.
- **Returns**:
  - Without `full`: `[{ _id, name, type, img }]` capped at 50.
  - With `full`: `[{ full document toObject() }]`.

### `get_compendium_document`
Fetch one specific entry from a pack.

- **Params**: `pack` (required), `id?` **or** `name?` (case-insensitive exact).
- **Returns**: full `toObject()` of the document. If not found: `{ error: "Document not found in <pack>" }`.

---

## World items

### `list_items`
Items that live at the world level (the Items sidebar), *not* items embedded on actors.

- **Params**: `type?` (system-specific, e.g. `"weapon"`, `"spell"`, `"gear"`)
- **Returns**: `[{ id, name, type, folder }]`

### `get_item`
Full world item document.

- **Params**: `id?` **or** `name?`
- **Returns**: `item.toObject()`.

---

## Scene

### `get_scene`
Summary of the active scene. Your go-to "what's happening right now" call.

- **Params**: none
- **Returns**:
  - `id, name` — scene identity.
  - `dimensions: { width, height }` — total scene size in pixels (including padding).
  - `grid: { size, type }` — `size` is pixels per grid square; `type` is `0` (gridless), `1` (square), `2–5` (hex variants).
  - `tokens: [{ id, name, actorId, x, y, elevation, hidden }]` — every token on the scene. `(x, y)` is the top-left of the token in pixels. Divide by `grid.size` to get grid coords.

---

## Data model

### `get_data_model`
System-defined schema for a document type. Use this to know what `system.*` fields are valid before you try `update_token` / writing code via `evaluate`.

- **Params**: `type?` (`"Actor"` or `"Item"`, default `"Actor"`), `subtype?` (e.g. `"character"`, `"monster"`).
- **Returns**: the system template object, or `{ _sampleFrom: name, system: {...} }` if no template is registered (falls back to showing a real sample actor's system data).

---

## Journals / Tables / Macros

### `list_journals`
- **Params**: `folder?`
- **Returns**: `[{ id, name, folder, pages: [{ id, name, type }] }]`. `type` is usually `"text"` or `"image"`.

### `list_tables`
Roll tables.
- **Params**: none
- **Returns**: `[{ id, name, formula, results }]`. `formula` is e.g. `"1d100"`; `results` is the entry count. (This tool does **not** roll on the table; there's currently no dedicated tool for that — use `evaluate` with `game.tables.get(id).draw()`.)

### `list_macros`
All macros. `command` is truncated to 200 chars with `"..."`; use `get_macro` for the full source.
- **Params**: none
- **Returns**: `[{ id, name, type, command }]`. `type` is `"script"` or `"chat"`.

### `get_macro`
Full macro source.
- **Params**: `id?` **or** `name?`
- **Returns**: `macro.toObject()` — includes full `command`.

---

## Debugging

### `get_console_errors`
Rolling buffer of `console.error`/`console.warn` captured by the bridge. The bridge patches `console.error` and `console.warn` at load; buffer cap is **1000** (oldest entries drop). Invaluable for catching silent failures inside the Foundry client.

- **Params**: `count?`, `sinceMs?` (default 60000), `level?`.
- **Returns**: `{ bufferSize, bufferCapacity, returned, entries }`.

### `trace_hooks`
Register listeners on **multiple** Foundry hooks at once and return a single time-ordered timeline of every firing. Use this to figure out what args hooks receive (and in what order) before writing code against them. (The old singular `trace_hook` was removed — pass a one-element `hooks` array for the same effect.)

- **Params**:
  - `hooks` (required) — array of hook names to listen on simultaneously. Examples: `["updateActor"]`, `["preCreateActor", "createActor", "preUpdateActor", "updateActor", "renderActorSheet"]`.
  - `count?` — max total firings across all hooks (1–500, default 50).
  - `timeoutMs?` — give up after this long (100–30000, default 5000).
  - `until?` — stop as soon as this hook fires (must be one of `hooks`).
- **Returns**: a time-ordered timeline where each entry is `{ at, dt, hook, args }` (`dt` is ms since the first firing).
- **How args are serialized**: Foundry documents are summarized to `{_document: "Actor"|"Token"|…, id, name, uuid}` (full serialization would be huge). Maps become objects, Sets become arrays, arrays are truncated to 10 items, object keys to 25. Depth capped at 3.
- **Practical uses**: Hook into `preCreateChatMessage` to see what a click produces; `renderActorSheet` to see the app/html/data args; `updateToken` to learn what field changed; trace an ordered list to diagnose hook-order bugs.
- **Siblings**: `trace_socket` (taps `game.socket` in/out events). See `trace_workflow` below to drive these from a preset.

### `trace_socket`
Tap `game.socket` for a time window. Captures outgoing `socket.emit` calls and incoming events (via Socket.IO `onAny`). Indispensable for debugging socket-driven state sync (e.g. modules that broadcast `module.<id>` events between GM and players).

- **Params**:
  - `filter?` — substring match on event name (e.g. `"module.vagabond-crawler"`); only matching events are recorded.
  - `count?` — max events to capture (1–1000, default 100).
  - `timeoutMs?` — give up after this long (100–30000, default 5000).
- **Returns**: time-ordered `{ at, dt, dir: "in"|"out", event, args }`.
- **Caveat**: don't run two `trace_socket` calls in parallel.

### `trace_workflow`
One-call **investigation** built on top of `trace_hooks` + `snapshot_actors` + `diff`. Expands a named **preset** into the exact hook list — Foundry has no wildcard hook matching, so this is how you trace a full Midi-QOL workflow without hand-typing ~12 hook strings — opens the window, optionally fires the action inside it, and (with `watch`) returns a before/after actor diff next to the timeline.

- **Params**:
  - `preset` (required) — one of `midi-full`, `midi-damage`, `active-effect`, `document-lifecycle`, `dnd5e-roll`. Defined in [`server/lib/workflow-presets.js`](lib/workflow-presets.js).
  - `watch?` — actor id(s)/name(s) to snapshot before+after and diff (live walk, so AE-modified derived stats surface).
  - `trigger?` — `{ tool, params }` bridge call to fire mid-window (e.g. `request_item_use`) so the action and its trace are one call.
  - `select?`, `extraHooks?`, `count?`, `timeoutMs?`, `until?`, `triggerDelayMs?` — overrides; each defaults from the preset.
- **Returns**: `{ preset, hooks, reason, timeline: [{dt, hook, args}], diff?, summary?, triggerError? }`.
- **See**: [`docs/debugging-recipes.md`](../docs/debugging-recipes.md) for the scenario→hook lookup table behind every preset.

### `evaluate`
**The power tool.** Runs arbitrary JavaScript in the Foundry client context. The `expression` you pass becomes the body of an async function with `game`, `canvas`, `ui` injected as parameters. Use `return` to send a value back.

- **Params**:
  - `expression` (required) — JS source. Multiple statements OK. Use `return`
    for the return value.
  - `timeoutMs?` — server-side wait limit, clamped to 5000–180000ms. Omit to
    retain the default 15000ms timeout.
  - `background?` — when true, start the evaluation as a job and return
    immediately with `{ jobId, status: "running", startedAt }`.
- **Returns**: `{ result, evalMs }`, a background job id, a large-result
  handle, or `{ error, stack }` on throw.
- **Return serialization**:
  - Foundry documents are `toObject()`'d (so you get the raw data, not the live doc).
  - Everything else is `JSON.parse(JSON.stringify(result))` — so non-serializable values (functions, circular refs, `undefined`) are lost.
  - Results larger than 256 KiB return `{ resultHandle, preview, totalBytes,
    totalChars }` instead of being sent inline.
- **Examples**:
  - `return game.user.name;`
  - `return canvas.walls.objects.children.length;`
  - `const a = game.actors.getName("Sassafrass"); return a.system.stats;`
  - `await game.settings.set("core", "compendiumConfiguration", {}); return "ok";`
- **Gotcha**: use `background: true` for work that may outlive any practical
  request timeout. Running JavaScript cannot be canceled safely.

### `job_result`
Poll a background evaluation or read a large JSON result in bounded chunks.

- **Params**:
  - `jobId` — job id or result handle returned by `evaluate`.
  - `waitMs?` — bounded long-poll wait, 0-10000ms.
  - `offset?` — character offset for a large serialized result.
  - `length?` — 1-65536 characters.
  - `delete?` — delete a settled entry instead of reading it.
- **Small completed jobs**: return the parsed result inline.
- **Large results**: return `{ chunk, offset, nextOffset, totalChars,
  totalBytes, done }`.
- **Storage bounds**: 30-minute TTL, 50 entries, 8 MiB per entry, 32 MiB
  total, and 10 concurrently running jobs. Old settled entries are evicted
  least-recently-used when space is required.
- **Cancellation**: running jobs cannot be deleted or canceled; deletion is
  allowed after settlement.

---

## Screenshots

### `screenshot`
Capture a Foundry image. **Returns an image** (MCP image content block). The `target` discriminator selects what to capture and which params apply. This merges the old `screenshot` / `screenshot_dom` / `capture_scene` tools.

- **Discriminator**: `target?` — `"canvas"` (default), `"dom"`, or `"scene_grid"`.
- **Params**:
  - `target?` — what to capture (see per-target rows below).
  - `scale?` **[canvas/dom]** — resize factor 0.1–1.0. Default 0.5 (canvas) / 0.75 (dom).
  - `quality?` **[canvas/dom]** — JPEG quality 0.1–1.0. Default 0.7 (canvas) / 0.8 (dom). Ignored for PNG.
  - `format?` **[canvas/dom]** — `"jpeg"` or `"png"`. Default `"jpeg"` (canvas) / `"png"` (dom).
  - `selector?` **[dom]** — CSS selector of the element to capture. Default `"body"` (entire page).

**`target: "canvas"`** (default) — fast snapshot of the PIXI game canvas (map + tokens, at your current pan/zoom). Uses `renderer.render(stage → RenderTexture)` + `renderer.extract.canvas(...)` — needed because the live WebGL context has `preserveDrawingBuffer: false`, so `view.toDataURL()` would return black.
- **Returns**: image content + caption `Canvas screenshot — W×H mime`.
- **Does NOT capture**: DOM overlays (character sheets, HUD, notifications, targeting reticles) — only the PIXI canvas. Use `target: "dom"` for those.
- **Hidden-tab handling**: advances the PIXI ticker immediately before capture so queued placeable render flags are applied even when the tab is backgrounded.

**`target: "dom"`** — screenshot an arbitrary **DOM element** (character sheets, HUD, chat cards, app windows, sidebar) via `html2canvas`. Fills the gap `target: "canvas"` leaves (PIXI-only). `html2canvas` is lazy-loaded from a CDN on first call and cached for subsequent calls. Useful `selector` values:
  - `'.app.sheet'` — a rendered actor/item sheet.
  - `'.app[data-appid="123"]'` — a specific app by id.
  - `'#chat-log'` — the chat panel.
  - `'#sidebar'` — the full right sidebar.
  - `'#party-bar'`, `'.crawler-bar'`, etc. — custom module UI.
- **Returns**: image content + caption `DOM screenshot of \`selector\` (tag#id) — W×H mime`.
- **Gotchas**:
  - `html2canvas` re-rasterizes by reading computed CSS. It's **approximate**: 3D transforms, `backdrop-filter`, complex shaders, and cross-origin images without CORS headers may render blank or wrong.
  - First call pays the CDN load cost (~2s first time, cached after).
  - Requires internet access the first time it's called on a given Foundry page load.

**`target: "scene_grid"`** — like `canvas` but at **full resolution**, **WebP**, and with a **coordinate grid overlay** — every grid cell gets a `"gx,gy"` label rendered in white-on-black. Much bigger payload; vastly better for spatial reasoning. Takes no extra capture params (`scale`/`quality`/`format`/`selector` are ignored).
- **Returns**: image content + caption `Scene "name" [id] — W×H image/webp with grid overlay`.
- **Overlay details**: 1px white grid lines at 15% alpha, PIXI.Text labels per cell at 22% of `gridSize` font size, black stroke, 65% alpha. Overlay is added to the stage, the stage is rendered to RenderTexture, the overlay is destroyed after. Live view unaffected once the next ticker frame runs.
- **Hidden-tab handling**: advances the PIXI ticker before adding and rendering the overlay, preventing newly-created placeables from being captured at `(0,0)`.

---

## Dice

### `roll`
Evaluate a dice formula. Can **force** specific dice results via `rig`.

- **Params**:
  - `formula` (required) — any Foundry roll formula. E.g. `"2d20kh + 5"`, `"(1d8+3)[slashing]"`, `"4d6dl1"`.
  - `rig?` — array of numbers. Values are consumed in roll order; clamped to each die's `faces` (e.g. `rig: [25]` on a d20 becomes a 20). Values past the queue roll normally.
- **Returns**: `{ formula, total, result, dice: [{ faces, results: [{ result, active, discarded }] }] }`
  - `result` is the post-evaluation formula string (e.g. `"1d8+3"` → `"5 + 3"`).
  - `active` is true for dice that contributed to the total (e.g. kept after `kh`).
  - `discarded` is true for dropped dice (e.g. lowest in `dl1`).
- **How rigging works**: the bridge patches `Die.prototype._roll` for the duration of the call and also watches the DOM for Foundry's roll-resolver dialog (the one that pops when "Manual Rolls" is enabled). Both paths consume from one shared queue, so order is preserved regardless of which fulfilment path Foundry picks.

---

## Items (actor-side) and DOM-driven actions

### `use_item`
Calls `item.use()` (fallback `item.roll()`) on an actor's item and captures any chat messages it produces. Accepts `rig`.

- **Params**:
  - `actor` (required) — id or name.
  - `item` (required) — id or name of an item **on that actor**.
  - `rig?` — forced dice values applied during the use.
  - `method?` — override the method name (e.g. `"rollAttack"` instead of `"use"`).
- **Returns**: `{ actor, item, method, messagesCreated, messages: [...] }` where each message is `{ id, speaker, flavor, content, rolls: [{ formula, total, dice }] }`.
- **Gotchas**:
  - Chat messages are captured via a temporary `createChatMessage` hook, with a 250ms post-call wait to catch async ones.
  - Many system-specific methods (Vagabond's `rollAttack`, `rollDamage`) require sheet DOM context and fail here — prefer `click` for those.

### `click`
Simulates a user click on a DOM element. Uses `HTMLElement.click()` (the native bubbling event), so delegated listeners fire. Captures chat messages produced during and immediately after.

- **Params**:
  - `selector` (required) — CSS selector. Typical Vagabond pattern: `'[data-action="rollWeapon"]'` or `'[data-action="vce-bless-mode"][data-mode="allies"]'`.
  - `rig?` — forced dice values; also feeds the roll-resolver dialog if one pops mid-click.
  - `openActor?` — render this actor's sheet first and wait (up to 2s) for it to appear in the DOM, so its buttons exist when your selector runs.
  - `waitMs?` — how long to wait after click for async chat messages (default 400).
- **Returns**: `{ selector, element: { tag, class, id, dataset, text }, messagesCreated, messages: [...] }` or `{ error, stack, element }`.
- **Why this exists**: Vagabond (and many systems) only dispatch the *real* attack → defender → damage → hit/crit pipeline via their sheet button handlers. Calling `item.rollAttack()` headlessly misses half of it. `click` gives you the real production path.

---

## Token manipulation (active scene)

### `get_token_details`
The most information-dense token query. Use this before any mutation.

- **Params**: `token`
- **Returns** (field-by-field):
  - **Geometry / state**:
    - `id, name` — token identity.
    - `x, y` — top-left pixel coords on the scene. Divide by `grid.size` (from `get_scene`) to get grid coords.
    - `width, height` — in grid units, *not* pixels. A 3×3 huge monster has `width: 3, height: 3`.
    - `rotation` — 0–359 degrees.
    - `elevation` — height above/below ground in scene distance units.
    - `hidden` — true if the token is invisible to players (GM still sees it with reduced opacity).
    - `disposition` — faction: `-1` hostile, `0` neutral, `1` friendly, `-2` secret.
    - `lockRotation` — if true, players/auto-rotation can't change `rotation`.
    - `sort` — z-index tiebreaker for overlapping tokens (higher = on top).
    - `img` — texture URL for the token artwork.
  - **`sight`** — what this token *perceives* (matters for `hasVision` tokens — usually PCs):
    - `enabled` — does this token have vision. If false, the token sees by scene ambient light only.
    - `range` — vision radius in scene distance units (0 = scene-global lighting only, no personal bright/dim).
    - `angle` — vision cone degrees (360 = omnidirectional).
    - `visionMode` — `"basic"` (default), or `"darkvision"`, `"monochromatic"`, `"tremorsense"`, etc. depending on system / modules.
    - `color` — tint applied to what the token sees (null = no tint).
    - `attenuation, brightness, saturation, contrast` — post-process filters for the token's visible area.
  - **`light`** — what this token *emits* into the scene:
    - `bright, dim` — radii of bright / dim light (scene distance units). Both 0 = emits nothing (torches are typically `bright: 20, dim: 40`).
    - `angle` — cone angle of the emitted light (torch cone vs. point source).
    - `color, alpha` — tint and opacity of emitted light.
    - `negative` — if true, emits *darkness* instead of light (dispels light in the radius).
    - `priority` — render order for overlapping lights (higher wins).
    - `animation` — `{ type, speed (1–10), intensity (1–10), reverse }`. `type` is a preset name: `"torch"`, `"pulse"`, `"chroma"`, `"flame"`, `null`, etc. Enables animated shaders.
    - `darkness: {min, max}` — only emit light when scene `darkness` is in this range (e.g. `{min: 0.25, max: 1}` for a torch that's off in daylight).
    - `luminosity` — 0 to 1 shader param for light strength.
    - `attenuation` — 0 to 1 falloff between bright and dim.
    - `coloration` — integer (1=Torch, 2=Pulse, etc.) shader preset.
    - `saturation, contrast, shadows` — additional shader knobs.
  - **`actor`** — linked actor snapshot. Fields:
    - `id, name, type` — actor identity.
    - `system` — full `actor.toObject().system` — HP, stats, skills, inventory, bonuses, etc. Shape is system-dependent; for Vagabond includes `health, mana, focus, stats, skills, saves, attributes, currency, bonuses`, and much more.
    - `statuses` — array of active status condition ids (e.g. `["poisoned", "prone"]`). Shortcut derived from active effects.
    - `effects` — `[{ id, name, statuses, disabled }]` — all Active Effects, including those that *don't* map to status conditions (buffs, persistent items).

### `get_available_conditions`
Lists system-registered status effects so you know valid `condition` values for `toggle_token_condition`.

- **Params**: none
- **Returns**: `[{ id, label, icon, hud }]`.
  - `id` — the canonical id (e.g. `"prone"`, `"poisoned"`, `"dead"`). This is what `toggle_token_condition` accepts.
  - `label` — localized display name.
  - `icon` — image URL.
  - `hud` — optional object with HUD metadata (category, grouping).

### `move_token`
Move a token to `(x, y)` on the active scene. The `pathed` flag selects between a straight move and A* pathfinding. Merges the old `move_token` / `move_token_pathed` tools.

- **Discriminator**: `pathed?` — `false` (default, straight move) or `true` (A* pathfinding, routes to `move_token_pathed`).
- **Params**:
  - `token` (required) — token id, name, or linked actor name.
  - `x, y` (required) — target coordinates in scene pixels.
  - `animate?` — animate the move (default true). When `pathed=true`, animates only the final hop.
  - `pathed?` — use A* pathfinding against scene walls. Default false.
  - `canOpenDoors?` **[pathed=true]** — open closed doors along the path (default false). Uses door-aware collision: A* routes as if doors were passable, and the handler calls `wall.update({ds: 1})` + waits 400ms before each door-crossing hop.
  - `elevation?` **[pathed=true]** — applied to the final waypoint only.
  - `rotation?` **[pathed=true]** — applied to the final waypoint only.
- **`pathed=false` (default)**: straight **teleport**. No wall check, no animation smoothing across obstacles. Pass `animate: false` for a zero-duration instant placement. Useful for quick GM-moves.
  - **Returns**: `{ id, name, x, y }`.
- **`pathed=true`**: **smart move.** Runs A* against scene walls via `CONFIG.Canvas.polygonBackends.move`. Only the **final hop** animates — intermediate hops teleport (otherwise you get jittery animation through walls).
  - **Returns**: `{ id, name, x, y, pathCost, doorsOpened: [wallId, ...] }`. `pathCost` is the A* step count (diagonal = 1, cardinal = 1). `doorsOpened` lists the wall ids of doors actually opened (in order).
  - **Errors**: `{ error: "Path blocked — no valid route to destination" }` if A* exhausts without reaching the target. Falls back to a plain teleport if no polygon backend or no grid (returns with `pathCost: null`).
  - **Limits**: A* node cap is 2500, so very long paths (50+ tiles) on cramped maps may fail even if technically routable — retry with a shorter hop.

### `update_token`
Patch multiple token fields at once. **Whitelisted keys only** — anything else is silently dropped.

- **Params**:
  - `token` (required)
  - `updates` (required object) — any subset of: `x, y, width, height, rotation, hidden, disposition, name, elevation, lockRotation, sort, alpha, tint`.
- **Returns**: `{ id, name, applied: { ...keys actually written } }` or `{ error }`.
- **NOT in whitelist**: `sight`, `light`, `texture`, `sort`-modifying flags, vision/light sub-objects. If you want those, use `evaluate` or extend the whitelist in `bridge.js`.

### `delete_tokens`
Batch-remove tokens from the active scene.

- **Params**: `tokens` — array of refs (ids, names, or linked actor names).
- **Returns**: `{ deleted: [ids], missing: [refs_that_didn't_match] }`.

### `toggle_token_condition`
Toggle a status condition on a token's **linked actor**. Uses Foundry v13's `Actor.toggleStatusEffect`.

- **Params**:
  - `token` (required)
  - `condition` (required) — condition id, name, or label. Match priority: id first, then name, then label.
  - `active?` — force `true` or `false`. Omit to toggle.
- **Returns**: `{ id, name, condition: "<resolved_id>", active, statuses: [all_current_status_ids] }`.
- **Errors**: `{ error: "Unknown condition: <x>" }` if not found — call `get_available_conditions` to see valid ids.

### `target`
Set the current user's targets. Equivalent to hovering tokens and pressing T. **Call this before `click`-ing an attack button** so the system's attack resolution knows the defender.

- **Params**: `tokens` — array of refs. Pass `[]` to clear targets.
- **Returns**: `{ targeted: [{ id, name, actor, hp }], missing: [refs], total }`. `hp` is the actor's `system.hp` if present (shape varies by system).

---

## Combat tracker

### `get_combat`
Read-only view of the active combat encounter. Returns `{ active: false }` when no combat is running.

- **Params**: none.
- **Returns** (when active):
  - `id`, `round`, `turn`, `started`, `sceneId`.
  - `currentCombatant` — `{ id, name, tokenId, actorId, initiative }` of whose turn it is, or `null`.
  - `combatants` — initiative-sorted array of `{ id, name, tokenId, actorId, initiative, hp, defeated, hidden }`. `hp` is system-specific (probes `system.attributes.hp` then `system.hp`).

### `combat` (write — opt-in)
Control the combat tracker. The `action` discriminator selects the operation. Merges the old `start_combat` / `advance_combat` / `end_combat` tools.

- **Discriminator**: `action` — `"start"`, `"advance"`, or `"end"`.
- **Params**:
  - `action` (required) — combat operation to perform.
  - `tokenIds?` **[start]** — token document ids to add as combatants before starting.
  - `rollInitiative?` **[start]** — `true`/`"all"` rolls every combatant; `"npc"` rolls NPCs only; omit or `false` to skip auto-roll.
  - `direction?` **[advance]** — `"next"` (default) or `"previous"`.
  - `audit?` — see [`audit`](#audit-optional-mutating-tools-only).
- **`action: "start"`**: start a combat encounter. Creates one on the current scene if none exists, optionally adds combatants and rolls initiative.
  - **Returns**: `{ started, combatId, round, combatantCount, currentCombatantId }`. If combat was already in progress: `{ started: false, reason, combatId, round }`.
- **`action: "advance"`**: step the combat turn forward or backward. Foundry handles round transitions automatically.
  - **Returns**: `{ combatId, round, turn, currentCombatant: { id, name, initiative } }`.
- **`action: "end"`**: end and delete the active combat encounter. The token roster on the scene is unaffected.
  - **Returns**: `{ id, round, combatantCount, ended: true }`.

---

## Chat

### `get_chat_messages`
Read chat history with filters. Returns recent messages chronologically.

- **Params**:
  - `limit` (optional, default 50, max 500) — max messages to return.
  - `since` (optional) — ISO timestamp string or epoch ms; only messages from that point forward.
  - `speaker` (optional) — filter by `speaker.alias` (commonly the actor name) or `speaker.actor` (actor id).
  - `includeRolls` (optional, default `true`).
  - `includeWhispers` (optional, default `false`).
- **Returns**: `{ total, returned, messages: [{ id, timestamp, time, type, speaker, content, isRoll, rolls, whisperTo }] }`.

### `send_chat_message` (write — opt-in)
Send a chat message. Speaker defaults to the routed user (GM by default).

- **Params**:
  - `content` — HTML body of the message.
  - `speaker` (optional) — display alias.
  - `actorId` / `tokenId` (optional) — speak as that document.
  - `whisperTo` (optional) — userName or array of userNames. Other users won't see it.
  - `type` (optional) — `"OOC"` (default), `"IC"`, `"EMOTE"`, `"WHISPER"`, `"ROLL"`, `"OTHER"`, or the corresponding integer.
- **Returns**: `{ id, timestamp, speaker, whisperedTo, contentPreview }`.

### `request_roll` (write — opt-in, interactive)
Pop a Roll dialog on the target user's screen. The user clicks Roll or Cancel; the tool returns when they respond (or after `timeoutSeconds`). Set `autoAccept: true` to skip the dialog and roll immediately — useful for GM-side automation and tests.

- **Params**:
  - `formula` — dice formula (e.g. `"1d20+5"`, `"2d6"`, `"@abilities.str.mod + 1d20"`).
  - `prompt` (optional) — text shown in the dialog. Default: `"The GM is requesting a roll."`
  - `label` (optional) — short label for dialog title + chat flavor (e.g. `"Perception DC 15"`).
  - `timeoutSeconds` (optional, default 60, max 300) — dialog wait time. The server-side RPC timeout is set to `timeoutSeconds + 5` so the dialog timeout fires first.
  - `autoAccept` (optional, default false) — skip dialog, roll immediately.
- **Returns**:
  - When rolled: `{ mode: "rolled" | "auto_rolled", formula, total, result, dice: [{ faces, results }] }`.
  - When cancelled by the user: `{ mode: "cancelled", formula }`.
  - When the dialog times out: `{ mode: "timed_out", formula }`.
  - When the dialog is dismissed without clicking a button: `{ mode: "dismissed", formula }`.
  - On a roll error: `{ mode: "error", formula, error }`.

---

## World authoring (opt-in: FOUNDRY_MCP_ALLOW_WRITE=1)

These tools **create and modify persistent world data** (actors, items, journals, folders). They are gated behind `FOUNDRY_MCP_ALLOW_WRITE=1` on the server. With the gate off, none of them are registered — they don't appear in any MCP client's tool list and cannot be called.

They all route through `targetUser`. The actual document creation runs in that user's browser context with that user's permissions.

### `self_test` (additional opt-in)
Run a guarded schema-drift smoke test after a Foundry core update.

- **Gates**: requires both `FOUNDRY_MCP_ALLOW_WRITE=1` and
  `FOUNDRY_MCP_ALLOW_SELF_TEST=1`.
- **Params**: `confirm: true` is mandatory.
- **Behavior**: creates uniquely named and flagged Actor, JournalEntry/Page,
  RollTable/TableResult, and Scene/Level documents; round-trips representative
  fields; then performs reverse-order cleanup in `finally`.
- **Cleanup guard**: a document is deleted only when its
  `foundry-mcp-live.selfTestRun` flag still matches the current run id.
- **Returns**: `{ runId, pass, checks, cleanup }`. Any failed assertion or
  undeleted document makes `pass` false.

### `folder`
Create or delete a sidebar folder. The `action` discriminator selects the operation. Merges the old `create_folder` / `delete_folder` tools.

- **Discriminator**: `action` — `"create"` or `"delete"`.
- **Params**:
  - `action` (required) — folder operation.
  - `type?` **[create]** — `"Actor"`, `"Item"`, `"JournalEntry"`, `"Scene"`, `"Macro"`, `"Playlist"`, `"RollTable"`, or `"Cards"`.
  - `name?` **[create]** — folder name (case-sensitive).
  - `parentFolder?` **[create]** — parent folder id or exact name within the same `type`.
  - `color?` **[create]** — hex like `"#3a5"`.
  - `folderId?` **[delete]** — folder document id.
  - `deleteContents?` **[delete]** — if `true`, delete every document and subfolder inside too. Default `false` (orphans them — sets their `folder` to null). Permanent.
  - `audit?` — see [`audit`](#audit-optional-mutating-tools-only).
- **`action: "create"`**: **Idempotent** — if a folder with the same `type` + `name` + `parentFolder` already exists, returns it with `existed: true` instead of creating a duplicate.
  - **Returns**: `{ id, name, type, parent, existed }`.
- **`action: "delete"`**: delete a folder by id.
  - **Returns**: `{ id, name, type, deleted: true, deleteContents }`.

### `actor_write`
Create, import, update, or delete a world actor. The `action` discriminator selects the operation. Merges the old `create_actor` / `create_actor_from_compendium` / `update_actor` / `delete_actor` tools.

> For `create`, **call `get_data_model({type:"Actor", subtype:"<type>"})` first** if you don't already know the shape for the active system. Without that, you'll likely produce a malformed actor.

- **Discriminator**: `action` — `"create"`, `"fromCompendium"`, `"update"`, or `"delete"`.
- **Params**:
  - `action` (required) — actor operation.
  - `actorId?` **[update/delete]** — actor document id.
  - `name?` **[create]** actor name / **[update]** replace the actor's name.
  - `type?` **[create]** — system-specific actor subtype (e.g. `"character"`, `"npc"` for dnd5e; `"Player"` for shadowdark).
  - `system?` **[create]** system-specific data block / **[update]** merged into the actor's `system` data.
  - `items?` **[create]** — inline items to attach at creation. Each entry is `{ pack, documentId, nameOverride? }` (compendium ref) or `{ name, type, system?, ... }` (inline).
  - `img?` **[create]** portrait path/URL / **[update]** replace the portrait image path/URL.
  - `prototypeToken?` **[create]** prototype token data / **[update]** merged into the prototype token (affects future tokens placed from this actor).
  - `folderId?` **[create/fromCompendium]** — target folder id (wins over `folderName` if both given).
  - `folderName?` **[create/fromCompendium]** — target folder by exact name. Auto-created as an `Actor` folder if missing.
  - `pack?` **[fromCompendium]** — pack id (e.g. `"dnd5e.monsters"`).
  - `documentId?` **[fromCompendium]** — document id within the pack (use `search_compendium` to find).
  - `nameOverride?` **[fromCompendium]** — rename the imported actor.
  - `audit?` — see [`audit`](#audit-optional-mutating-tools-only).
- **`action: "create"`** — build a brand-new actor in the world. Returns `{ id, name, type, folder, itemIds }`.
- **`action: "fromCompendium"`** — import an already-statted actor from a compendium pack. Returns `{ id, name, type, folder, sourcePack, sourceDocId }`.
- **`action: "update"`** — patch an existing actor (at least one of `name`/`img`/`system`/`prototypeToken` required). Use this to tweak HP/stats/name/portrait after import instead of recreating. Returns `{ actorId, fieldsUpdated }`.
- **`action: "delete"`** — permanent (Foundry's undo does not cover deletes). Call `actor_write({action:"update"})` snapshots, `get_actor`, or `snapshot_actors` first if any data needs to be preserved. Returns `{ id, name, type, deleted: true }`.

### `actor_items`
Manage embedded items (weapons, spells, gear, features) on an existing actor. The `action` discriminator selects the operation. Merges the old `add_items_to_actor` / `update_item_on_actor` / `delete_items_from_actor` tools.

- **Discriminator**: `action` — `"add"`, `"update"`, or `"delete"`.
- **Params**:
  - `action` (required) — actor-item operation.
  - `actorId` (required) — actor document id.
  - `items?` **[add]** — array of `{ pack, documentId, nameOverride? }` (compendium ref) or `{ name, type, system?, ... }` (inline) entries.
  - `itemId?` **[update]** — embedded item id.
  - `data?` **[update]** — fields to merge into the item. Top-level fields (`name`, `img`) and `system.*` sub-paths are all accepted; Foundry's diff-update semantics apply.
  - `itemIds?` **[delete]** — array of embedded item ids to remove.
  - `audit?` — see [`audit`](#audit-optional-mutating-tools-only).
- **`action: "add"`** — Returns `{ actorId, added: [{ id, name, source }] }` — `source` is `"<pack>/<docId>"` for compendium imports or `"inline"`.
- **`action: "update"`** — Returns `{ actorId, itemId, fieldsUpdated: [...] }`.
- **`action: "delete"`** — Returns `{ actorId, deleted: [{ id, name, type }], missing: [ids] }` — `missing` lists ids that weren't on the actor (the rest are deleted).

### `actor_ownership`
Read or set an actor's ownership map. The `action` discriminator selects the operation. Merges the old `get_actor_ownership` / `set_actor_ownership` tools.

- **Discriminator**: `action` — `"get"` or `"set"`.
- **Params**:
  - `action` (required) — ownership operation.
  - `actorId` (required) — actor document id.
  - `ownership?` **[set]** — a map of `{ user → level }`, **merged** with existing ownership.
    - **Keys** can be `"default"` (every user not explicitly listed), a userId, or a case-sensitive userName.
    - **Levels** can be string names (`"NONE"`, `"LIMITED"`, `"OBSERVER"`, `"OWNER"`, `"INHERIT"`) or the corresponding ints (`0`–`3`, or `-1` for INHERIT).
    - To clear a user's permission, pass them as `"NONE"` explicitly — omitting them leaves their existing level intact.
  - `audit?` — see [`audit`](#audit-optional-mutating-tools-only).
- **`action: "get"`** — Returns `{ actorId, actorName, default: "<level>", users: [{ userId, userName, role, active, level }] }`.
- **`action: "set"`** — Returns `{ actorId, actorName, changed: [...] }` — `changed` lists each user whose level was applied, with the resolved userId.

**Example** — give Bob full control, lock everyone else out:
```json
{
  "action": "set",
  "actorId": "abc123",
  "ownership": { "default": "NONE", "Bob": "OWNER" }
}
```

### `journal`
Manage journal entries and their pages. The `action` discriminator selects the operation. Merges the old `create_journal_entry` / `add_page_to_journal_entry` / `update_journal_page` / `delete_journal_page` / `delete_journal_entry` tools.

- **Discriminator**: `action` — `"create"`, `"addPage"`, `"updatePage"`, `"deletePage"`, or `"delete"`.
- **Params**:
  - `action` (required) — journal operation.
  - `name?` **[create]** journal entry name (sidebar label) / **[updatePage]** replace the page name.
  - `pages?` **[create]** — non-empty array of `{ name, type?, text?: { content, format? }, src? }`. `type` defaults to `"text"` (other values `"image"`, `"pdf"`, `"video"` use `src`); `text.format` defaults to `1` (HTML), `2` is Markdown.
  - `folderId?` **[create]** — target folder id.
  - `folderName?` **[create]** — target folder by exact name. Auto-created as a `JournalEntry` folder if missing.
  - `journalId?` **[addPage/updatePage/deletePage/delete]** — parent journal entry id.
  - `pageId?` **[updatePage/deletePage]** — page id within that journal.
  - `page?` **[addPage]** — `{ name, type?, text?: { content, format? }, src? }`. Same shape as a `create` `pages[]` entry.
  - `content?` **[updatePage]** — replace the page body wholesale.
  - `appendContent?` **[updatePage]** — append to the existing body. Ignored if `content` is also given.
  - `audit?` — see [`audit`](#audit-optional-mutating-tools-only).
- **`action: "create"`** — create an entry with one or more pages. Returns `{ id, name, folder, pageIds }`.
- **`action: "addPage"`** — append a page to an existing entry. Returns `{ journalId, pageId, name }`.
- **`action: "updatePage"`** — designed for **iterative writing** (first `create` a skeleton, then flesh it out). Returns `{ journalId, pageId, fieldsUpdated }` — `fieldsUpdated` lists which fields changed (`"name"`, `"text.content (replaced)"`, `"text.content (appended)"`).
- **`action: "deletePage"`** — delete one page; the entry remains. Returns `{ journalId, pageId, name, deleted: true }`.
- **`action: "delete"`** — delete the entry and all its pages (permanent). Returns `{ id, name, pageCount, deleted: true }`.

### `create_token`
Place a new token for an actor onto a scene. Defaults to the active scene when `sceneId` is omitted. Pass coordinates as **either** pixels OR cells — cell coords win if both are provided.

- **Params**:
  - `actorId` — actor whose token to place.
  - `sceneId` (optional) — target scene. Default: active scene.
  - `x`, `y` (optional) — pixel coordinates.
  - `gridX`, `gridY` (optional) — grid cell coordinates (0-indexed). Multiplied by the scene's grid size to get pixels.
  - `hidden` (optional) — spawn hidden to non-GMs.
  - `name` (optional) — override the token name (defaults to actor name).
  - `rotation` (optional) — rotation in degrees.
- **Returns**: `{ id, sceneId, actorId, name, x, y, hidden }`.

The token inherits the actor's **prototype token** — image, scale, vision, disposition, etc. all carry over.

### `scene`
Create, update, activate, or delete a scene. The `action` discriminator selects the operation. Merges the old `create_scene` / `update_scene` / `activate_scene` / `delete_scene` tools.

- **Discriminator**: `action` — `"create"`, `"update"`, `"activate"`, or `"delete"`.
- **Params**:
  - `action` (required) — scene operation.
  - `sceneId?` **[update]** target scene id / **[activate/delete]** scene document id (preferred — unambiguous).
  - `sceneName?` **[activate/delete]** — scene name (exact match). Used only if `sceneId` is omitted.
  - `name?` **[create]** scene name (sidebar label) / **[update]** new scene name.
  - `width?` **[create]** — width in pixels. Default 4000.
  - `height?` **[create]** — height in pixels. Default 3000.
  - `gridType?` **[create]** — `CONST.GRID_TYPES` value (0=Gridless, 1=Square, 2–5=Hex variants). Default 1.
  - `gridSize?` **[create]** — grid cell size in pixels. Default 100.
  - `gridAlpha?` **[create]** — grid line alpha (0.0–1.0). Default 0.2.
  - `folderId?` **[create]** — parent folder id (Scene type).
  - `activate?` **[create]** — activate after creating. Default true.
  - `padding?` **[create/update]** — outer padding (0.0–0.5). Default 0.25.
  - `backgroundColor?` **[create/update]** — hex background color. Default `"#1c1c1c"`.
  - `background?` **[create/update]** — background image path or data object (e.g. `{src: "path/to/image.webp"}`). On v14, background fields map to `Level.background` and transforms to `Level.textures`.
  - `foreground?` **[create/update]** — foreground texture data; Level-backed on v14.
  - `levelFog?` **[create/update]** — level fog texture data `{src, tint}`; v14 only.
  - `fog?` **[create/update]** — scene fog config, e.g. `{mode: 0|1|2, colors}`.
  - `fogExploration?` **[create/update]** — compatibility boolean. On v14 update maps `false`→`fog.mode 0` and `true`→`fog.mode 1`.
  - `grid?` **[update]** — grid object (e.g. `{size: 100, type: 1, alpha: 0.2}`).
  - `navigation?` **[update]** — whether the scene appears in the navigation bar.
  - `sort?` **[update]** — navigation sort order.
  - `navName?` **[update]** — short name shown in the navigation bar.
  - `initial?` **[update]** — initial view config (e.g. `{level: "<levelId>", x, y, scale}`).
  - `force?` **[delete]** — set true to delete even if the scene is currently active. Default false.
  - `audit?` — see [`audit`](#audit-optional-mutating-tools-only).
- **`action: "create"`** — activates the new scene unless `activate: false`.
- **`action: "update"`** — patches the whitelisted fields above, preserving the rest.
- **`action: "activate"`** — switches the canvas to view the scene.
- **`action: "delete"`** — permanent; `force: true` is required to delete the active scene.

### `scene_level`
Manage levels (floors) of a multi-level scene. **v14 only** — `scene.levels` is a v14-native EmbeddedCollection. The `action` discriminator selects the operation. Merges the old `add_scene_level` / `update_scene_level` / `remove_scene_level` tools.

- **Discriminator**: `action` — `"add"`, `"update"`, or `"remove"`.
- **Params**:
  - `action` (required) — scene-level operation.
  - `sceneId` (required) — target scene id.
  - `name?` **[add]** level name (e.g. `"Ground"`, `"Upper"`, `"Basement"`) / **[update]** new level name.
  - `bottom?` **[add]** lower bound of the elevation range (in feet) / **[update]** new lower bound.
  - `top?` **[add]** upper bound of the elevation range (in feet) / **[update]** new upper bound.
  - `levelId?` **[update/remove]** — level document id.
  - `audit?` — see [`audit`](#audit-optional-mutating-tools-only).
- **`action: "add"`** — returns the new level's id, name, and elevation range.
- **`action: "update"`** — changes the given fields, preserving the rest.
- **`action: "remove"`** — deletes a level; refuses on the only remaining one. Permanent.

### `region`
Manage Regions (v13+) on a scene. Use `list_region_behavior_types` for behavior subtype schemas. The `action` discriminator selects the operation. Merges the old `create_region` / `update_region` / `delete_region` tools.

- **Discriminator**: `action` — `"create"`, `"update"`, or `"delete"`.
- **Params**:
  - `action` (required) — region operation.
  - `sceneId` (required) — target scene id.
  - `name?` **[create]** — region name.
  - `shapes?` **[create]** — non-empty array of RegionShape data (e.g. `{type:"rectangle", x, y, width, height}`).
  - `behaviors?` **[create]** — RegionBehavior data (e.g. `{type:"executeScript", system:{source}}`).
  - `levels?` **[create]** — level ids the region applies to.
  - `color?` **[create]** — hex color for the region overlay.
  - `visibility?` **[create]** — visibility level (0–4 per Foundry's enum).
  - `locked?` **[create]** — lock the region from interactive selection.
  - `elevation?` **[create]** — override elevation range `{bottom, top}`.
  - `ownership?` **[create]** — per-user ownership map.
  - `regionId?` **[update/delete]** — region document id.
  - `patch?` **[update]** — fields to merge into the region (dotted paths like `elevation.bottom` accepted; e.g. `{visibility: 0, locked: false}`).
  - `audit?` — see [`audit`](#audit-optional-mutating-tools-only).
- **`action: "delete"`** — permanent.

### `list_scenes`
List every scene in the world. Use to enumerate available scenes when you only know a name fragment or need to find which scene is currently active.

- **Params**: none.
- **Returns**: `[{ id, name, active, folder }]` per scene.

### `place_measured_template`
Drop a MeasuredTemplate onto a scene (fireball circle, cone, wall ray, rectangle) for spell areas of effect. The template is created immediately at the given coordinates — no preview/place UX.

- **Params**:
  - `type?` — `"circle"` (default), `"cone"`, `"rect"`, or `"ray"`.
  - `x`, `y` (required) — pixel coordinates of the template origin.
  - `distance` (required) — template distance in grid units (e.g. 20 for a 20ft cone).
  - `direction?` — direction in degrees (for cone/ray). Default 0.
  - `angle?` — cone angle in degrees. Default 53 for cones, 0 otherwise.
  - `width?` — ray width (for `type="ray"`). Default 0.
  - `fillColor?` — hex color for the template fill. Defaults to the user's color.
  - `texture?` — optional texture image path overlaying the template.
  - `flags?` — module flags to attach (e.g. `{ "spell-effects": { name: "fireball" } }`).
  - `sceneId?` — target scene id. Default: active scene.
  - `hidden?` — create hidden to non-GMs. Default false.
  - `audit?` — see [`audit`](#audit-optional-mutating-tools-only).

---

## Typed rolls + item use (opt-in: FOUNDRY_MCP_ALLOW_WRITE=1)

These tools use system-native APIs to handle modifiers, advantage, and formatting correctly. Supported systems: `dnd5e`, `pf2e`, `shadowdark`, `vagabond`.

### `request_check`
Triggers a system-native skill, ability, or save check on an actor. Handles system-specific modifiers and formatting; dialogs always suppressed. Normalizes the result into a canonical shape. (Replaces the removed `request_roll_typed` — same behavior, canonical name.)
- **actorId**: ID or name of the actor.
- **type**: `skill`, `ability`, or `save`.
- **identifier**: System-specific slug (e.g. `ath` for 5e Athletics, `athletics` for PF2e, `str` for Shadowdark).
- **dc**: (Optional) Target DC for success evaluation.
- **adv**: (Optional) `advantage`, `disadvantage`, or `normal` (dnd5e + shadowdark only; ignored elsewhere).

### `request_item_use`
Trigger an item's combat workflow. The `phase` discriminator selects which part runs and which params apply; dialogs always suppressed. Merges the old single `request_item_use` plus `request_attack_roll` and `request_damage_roll`.

- **Discriminator**: `phase` — `"full"` (default), `"attack"`, or `"damage"`.
- **Params**:
  - `phase?` — which workflow part to run.
  - `actorId` (required) — actor id or name.
  - `itemId` (required) — item/weapon id or name.
  - `targetIds?` **[full]** — if provided, damage is applied to these targets on hit.
  - `activityId?` **[full/attack]** — D&D 5e activity id (when an item has multiple attack activities).
  - `adv?` **[full/attack]** — `"normal"`, `"advantage"`, or `"disadvantage"` (system-dependent).
  - `isCritical?` **[damage]** — force critical damage (doubles dice on d20 systems).
- **`phase: "full"`** (default, recommended for combat) — full Attack -> Hit? -> Damage -> (optional) Apply workflow. Threads crit state from the attack into damage automatically. Returns a chained result object (attack, damage, application details).
- **`phase: "attack"`** — only the attack roll.
- **`phase: "damage"`** — only the damage roll; caller supplies crit state. Does NOT re-roll the attack — fetches the activity/strike directly from the item.

### `apply_damage`
Applies damage to one or more targets with mixed outcomes (e.g., fireball with some targets saving).
- **damages**: Array of `{ targetId, amount, type?, multiplier? }`.
- **multiplier**: 0 for immune, 0.5 for save-for-half, 1 for full, 2 for vulnerability.

---

## Patterns & workflows

**Discovery flow** — "what's happening?":
1. `get_game_info` → confirms bridge alive, tells you the system.
2. `get_scene` → lists tokens on the map with their positions.
3. `get_token_details <name>` → deep info on one token.
4. `screenshot { target: "scene_grid" }` → visual confirmation with grid labels.

**Debugging flow** — "something's broken":
1. `get_console_errors` → see what's been throwing in the browser.
2. `trace_hooks { hooks: ["relevantHook"] }` → learn what args the hook receives.
3. `evaluate "return <some probe>;"` → prototype against live game state.
4. Add a proper handler to `bridge.js` once you know what works.

**Deterministic test flow** — "prove this attack hits":
1. `target ["Goblin"]` → set defender.
2. `click '[data-action="rollWeapon"]'` with `rig: [15, 6, 6]` and `openActor: "Sassafrass"` → force attack=15, damage dice=6,6.
3. Inspect the returned chat messages for hit/miss/damage.

**Visual verify after mutation**:
1. `move_token { pathed: true }` to a target cell.
2. `screenshot { target: "scene_grid" }` → confirm the grid position visually.

**Rigged dice key rules**:
- `rig` works on `roll`, `use_item`, and `click`.
- Values are consumed in roll order across *all* dice in the sequence. Plan the full queue: `[attack, damage_die1, damage_die2, ...]`.
- Values past the queue roll normally from the real RNG.
- Values are clamped to each die's `faces` (so `[99]` on a d20 becomes 20).

**Gotchas not tied to a specific tool**:
- The bridge holds **one** Foundry connection at a time. If the connection drops, in-flight `pendingRequests` on the server reject with "Foundry disconnected".
- Reloading Foundry (F5) is the right way to pick up new bridge code; the module reconnects automatically with 5s backoff.
- Restarting the Node server requires MCP clients to re-initialize (the session ids invalidate).
- `update_token`'s whitelist is a deliberate guard against accidental destructive writes. Extend it in `bridge.js:handlers.update_token` if you need more.
