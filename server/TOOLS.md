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

The only non-routed (server-local) tool is `list_connected_bridges` itself.

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
Rolling buffer of `console.error`/`console.warn` captured by the bridge. The bridge patches `console.error` and `console.warn` at load; buffer cap is **50** (oldest entries drop). Invaluable for catching silent failures inside the Foundry client.

- **Params**: `count?` (default: all; max 50)
- **Returns**: `[{ level: "error"|"warn", message, timestamp }]` newest last. `message` is the joined arguments; objects are JSON-stringified.

### `trace_hook`
Registers a temporary listener on a named Foundry hook, collects firings, then unregisters. Use this to figure out what args a hook receives before writing code against it.

- **Params**:
  - `hook` (required) — hook name. Examples: `"updateActor"`, `"createChatMessage"`, `"renderCharacterSheet"`, `"preUpdateToken"`, `"updateCombat"`.
  - `count?` — stop after this many firings (1–20, default 1).
  - `timeoutMs?` — give up after this long (100–12000, default 5000).
- **Returns**: `{ hook, reason: "count"|"timeout", firings: [{ at: timestamp, args: [...] }] }`
- **How args are serialized**: Foundry documents are summarized to `{_document: "Actor"|"Token"|…, id, name, uuid}` (full serialization would be huge). Maps become objects, Sets become arrays, arrays are truncated to 10 items, object keys to 25. Depth capped at 3.
- **Practical uses**: Hook into `preCreateChatMessage` to see what a click produces; `renderActorSheet` to see the app/html/data args; `updateToken` to learn what field changed.

### `evaluate`
**The power tool.** Runs arbitrary JavaScript in the Foundry client context. The `expression` you pass becomes the body of an async function with `game`, `canvas`, `ui` injected as parameters. Use `return` to send a value back.

- **Params**: `expression` (required) — JS source. Multiple statements OK. Use `return` for the return value.
- **Returns**: serialized return value, **or** `{ error: message, stack }` on throw.
- **Return serialization**:
  - Foundry documents are `toObject()`'d (so you get the raw data, not the live doc).
  - Everything else is `JSON.parse(JSON.stringify(result))` — so non-serializable values (functions, circular refs, `undefined`) are lost.
- **Examples**:
  - `return game.user.name;`
  - `return canvas.walls.objects.children.length;`
  - `const a = game.actors.getName("Sassafrass"); return a.system.stats;`
  - `await game.settings.set("core", "compendiumConfiguration", {}); return "ok";`
- **Gotcha**: you see the `return` value synchronously-serialized at the moment the function returns. To wait on a hook or a UI event, block inside the expression.

---

## Screenshots

### `screenshot`
Fast snapshot of the PIXI game canvas (map + tokens, at your current pan/zoom). Uses `renderer.render(stage → RenderTexture)` + `renderer.extract.canvas(...)` — needed because the live WebGL context has `preserveDrawingBuffer: false`, so `view.toDataURL()` would return black.

- **Params**:
  - `scale?` — 0.1–1.0, default 0.5. Downscales before encoding.
  - `quality?` — 0.1–1.0, default 0.7 (JPEG only).
  - `format?` — `"jpeg"` (default) or `"png"`.
- **Returns**: MCP image content + caption `Canvas screenshot — W×H mime`.
- **Does NOT capture**: DOM overlays (character sheets, HUD, notifications, targeting reticles) — only the PIXI canvas.

### `screenshot_dom`
Screenshot an arbitrary **DOM element** (character sheets, HUD, chat cards, app windows, sidebar) via `html2canvas`. Fills the gap that `screenshot` intentionally leaves — `screenshot` is PIXI-only. `html2canvas` is lazy-loaded from `cdn.jsdelivr.net` on first call and cached on `globalThis._mcp_html2canvas` for subsequent calls.

- **Params**:
  - `selector?` — CSS selector of the element to capture. Default `"body"` (entire page). Useful selectors:
    - `'.app.sheet'` — a rendered actor/item sheet.
    - `'.app[data-appid="123"]'` — a specific app by id.
    - `'#chat-log'` — the chat panel.
    - `'#sidebar'` — the full right sidebar.
    - `'#party-bar'`, `'.crawler-bar'`, etc. — custom module UI.
  - `scale?` — downscale factor 0.1–1.0 (default 0.75).
  - `quality?` — JPEG quality 0.1–1.0 (default 0.8; ignored for PNG).
  - `format?` — `"png"` (default; better for UI with solid colors) or `"jpeg"`.
- **Returns**: MCP image content + caption `DOM screenshot of \`selector\` (tag#id) — W×H mime`.
- **Gotchas**:
  - `html2canvas` re-rasterizes by reading computed CSS. It's **approximate**: 3D transforms, `backdrop-filter`, complex shaders, and cross-origin images without CORS headers may render blank or wrong.
  - First call pays the CDN load cost (~2s first time, cached after).
  - Requires internet access the first time it's called on a given Foundry page load.

### `capture_scene`
Like `screenshot` but at **full resolution**, **WebP**, and with a **coordinate grid overlay** — every grid cell gets a `"gx,gy"` label rendered in white-on-black. Much bigger payload; vastly better for spatial reasoning.

- **Params**: none
- **Returns**: MCP image content + caption `Scene "name" [id] — W×H image/webp with grid overlay`.
- **Overlay details**: 1px white grid lines at 15% alpha, PIXI.Text labels per cell at 22% of `gridSize` font size, black stroke, 65% alpha. Overlay is added to the stage, the stage is rendered to RenderTexture, the overlay is destroyed after. Live view unaffected once the next ticker frame runs.

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
**Teleport.** No wall check, no animation smoothing across obstacles. Useful for quick GM-moves.

- **Params**: `token`, `x` (pixels), `y` (pixels), `animate?` (default true; if false, teleports with zero-duration animation).
- **Returns**: `{ id, name, x, y }`.

### `move_token_pathed`
**Smart move.** Runs A* against scene walls via `CONFIG.Canvas.polygonBackends.move`. Optionally opens closed doors along the path. Only the **final hop** animates — intermediate hops teleport (otherwise you get jittery animation through walls).

- **Params**:
  - `token` (required), `x, y` (pixels, required).
  - `animate?` — animate the final hop (default true).
  - `canOpenDoors?` — open closed doors en route (default false). When true, uses door-aware collision: A* routes as if doors were passable, and the handler calls `wall.update({ds: 1})` + waits 400ms before each door-crossing hop.
  - `elevation?, rotation?` — applied to the final waypoint only.
- **Returns**: `{ id, name, x, y, pathCost, doorsOpened: [wallId, ...] }`. `pathCost` is the A* step count (diagonal = 1, cardinal = 1). `doorsOpened` lists the wall ids of doors actually opened (in order).
- **Errors**:
  - `{ error: "Path blocked — no valid route to destination" }` if A* exhausts without reaching the target.
  - Falls back to a plain teleport if no polygon backend or no grid (returns with `pathCost: null`).
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

## World authoring (opt-in: FOUNDRY_MCP_ALLOW_WRITE=1)

These tools **create and modify persistent world data** (actors, items, journals, folders). They are gated behind `FOUNDRY_MCP_ALLOW_WRITE=1` on the server. With the gate off, none of them are registered — they don't appear in any MCP client's tool list and cannot be called.

They all route through `targetUser`. The actual document creation runs in that user's browser context with that user's permissions.

### `create_folder`
Create a sidebar folder. **Idempotent** — if a folder with the same `type` + `name` + `parentFolder` already exists, returns it with `existed: true` instead of creating a duplicate.

- **Params**:
  - `type` — `"Actor"`, `"Item"`, `"JournalEntry"`, `"Scene"`, `"Macro"`, `"Playlist"`, `"RollTable"`, or `"Cards"`.
  - `name` — folder name (case-sensitive).
  - `parentFolder` (optional) — parent folder id or exact name within the same `type`.
  - `color` (optional) — hex like `"#3a5"`.
- **Returns**: `{ id, name, type, parent, existed }`.

### `create_actor_from_compendium`
Import an actor from a compendium pack into the world.

- **Params**:
  - `pack` — pack id (e.g. `"dnd5e.monsters"`).
  - `documentId` — document id within the pack (use `search_compendium` to find).
  - `folderId` (optional) — target folder id.
  - `folderName` (optional) — target folder by exact name. Auto-created as an `Actor` folder if missing. `folderId` wins if both are given.
  - `nameOverride` (optional) — rename on import.
- **Returns**: `{ id, name, type, folder, sourcePack, sourceDocId }`.

### `create_actor`
Create a brand-new actor in the world. System-agnostic — `system` is the system-specific data block.

> **Call `get_data_model({type:"Actor", subtype:"<type>"})` first** if you don't already know the shape for the active system. Without that, you'll likely produce a malformed actor.

- **Params**:
  - `name` — actor name.
  - `type` — system-specific actor subtype (e.g. `"character"`, `"npc"` for dnd5e).
  - `system` (optional) — system-specific data object.
  - `items` (optional) — inline items to attach at creation. Each entry is either `{ pack, documentId, nameOverride? }` (compendium ref) or `{ name, type, system?, ... }` (inline).
  - `img` (optional) — portrait path/URL.
  - `prototypeToken` (optional) — prototype token data.
  - `folderId` / `folderName` (optional) — same semantics as `create_actor_from_compendium`.
- **Returns**: `{ id, name, type, folder, itemIds }`.

### `add_items_to_actor`
Add embedded items (weapons, spells, gear, features) to an existing actor.

- **Params**:
  - `actorId` — actor document id.
  - `items` — array of `{ pack, documentId, nameOverride? }` (compendium) or `{ name, type, system?, ... }` (inline) entries.
- **Returns**: `{ actorId, added: [{ id, name, source }] }` — `source` is `"<pack>/<docId>"` for compendium imports or `"inline"`.

### `create_journal_entry`
Create a journal entry with one or more pages.

- **Params**:
  - `name` — journal entry name (sidebar label).
  - `pages` — non-empty array of `{ name, type?, text?: { content, format? }, src? }`.
    - `type` defaults to `"text"`. Other values: `"image"`, `"pdf"`, `"video"` (use `src`).
    - `text.format` defaults to `1` (HTML). `2` is Markdown.
  - `folderId` / `folderName` (optional) — same semantics as the other writes. Auto-created as a `JournalEntry` folder if needed.
- **Returns**: `{ id, name, folder, pageIds }`.

### `update_journal_page`
Update a journal page's name and/or text content. Designed for **iterative writing** — first call creates a skeleton via `create_journal_entry`, follow-up calls flesh it out.

- **Params**:
  - `journalId` — parent journal entry id.
  - `pageId` — page id within that journal.
  - `name` (optional) — replace page name.
  - `content` (optional) — replace page body wholesale.
  - `appendContent` (optional) — append to existing body. Ignored if `content` is also given.
- **Returns**: `{ journalId, pageId, fieldsUpdated }` — `fieldsUpdated` lists which fields actually changed (`"name"`, `"text.content (replaced)"`, `"text.content (appended)"`).

---

## Patterns & workflows

**Discovery flow** — "what's happening?":
1. `get_game_info` → confirms bridge alive, tells you the system.
2. `get_scene` → lists tokens on the map with their positions.
3. `get_token_details <name>` → deep info on one token.
4. `capture_scene` → visual confirmation with grid labels.

**Debugging flow** — "something's broken":
1. `get_console_errors` → see what's been throwing in the browser.
2. `trace_hook "relevantHook"` → learn what args the hook receives.
3. `evaluate "return <some probe>;"` → prototype against live game state.
4. Add a proper handler to `bridge.js` once you know what works.

**Deterministic test flow** — "prove this attack hits":
1. `target ["Goblin"]` → set defender.
2. `click '[data-action="rollWeapon"]'` with `rig: [15, 6, 6]` and `openActor: "Sassafrass"` → force attack=15, damage dice=6,6.
3. Inspect the returned chat messages for hit/miss/damage.

**Visual verify after mutation**:
1. `move_token_pathed` to a target cell.
2. `capture_scene` → confirm the grid position visually.

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
