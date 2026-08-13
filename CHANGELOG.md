# Changelog

All notable changes to Foundry MCP Live are documented in this file.

## [Unreleased]

### Fixed

- **Document `::` rather than `0.0.0.0` for `FOUNDRY_WS_HOST`.** `0.0.0.0` is
  IPv4-only, so a browser that resolves `localhost` to `::1` finds nothing
  listening and fails with a bare "can't establish a connection". Every
  shell-based check passes, because command-line clients fall back to IPv4 and
  browsers may not — so the bridge looks reachable from the server while a real
  client can't reach it. `::` binds IPv6 and accepts IPv4 via v4-mapped
  addresses, so every address form works regardless of resolver preference.

## [0.18.0] - 2026-08-13

### Added

- **LAN clients: "MCP server address" module setting.** The bridge URL was
  hardcoded to `ws://localhost:3001`, so a second device on the network could
  never connect — its "localhost" is itself, not the machine running the MCP
  server. The URL is now resolved per-connect: blank (the default) derives it
  from the page host when that host is loopback or RFC1918, and falls back to
  `localhost` for public origins, since a hosted Foundry doesn't run your MCP
  server. Client-scoped, so each device sets its own. Accepts `192.168.0.106`,
  `192.168.0.106:3001`, or a full `ws://host:port`.
- **"MCP bridge token" world setting.** The token was previously per-browser
  localStorage, set through devtools — not something you can ask a normal user
  or a player to do, and it had to be repeated on every device. It's now a
  world-scoped setting the GM fills in once; Foundry hands world settings to
  every client that loads the world, so each device authenticates with no setup
  of its own. localStorage is still read as a per-client override, with the
  world setting winning when both are present so a stale hand-set value can't
  lock a client out of a world whose token has since been corrected.
- **`FOUNDRY_WS_TOKEN`** — a bridge-only secret, defaulting to `BRIDGE_TOKEN`.
  Exposing the bridge with `FOUNDRY_WS_HOST` needs auth, but `BRIDGE_TOKEN`
  also puts Bearer auth on `/mcp`, which breaks MCP clients that can't send a
  header (Codex has no per-server header config). Since `/mcp` is bound to
  `127.0.0.1` in code and unreachable off-box anyway, the two are now separable.
- **Startup warning when the bridge is exposed without a token.** Binding
  off-loopback with no `FOUNDRY_WS_TOKEN`/`BRIDGE_TOKEN` lets anything that can
  route to the port register as a GM bridge; the server now says so on boot.
- **Token rejection is visible.** A close with code 1008 (the server's only use
  of it is a token mismatch) now raises a permanent Foundry notification naming
  the `localStorage.mcpBridgeToken` fix, instead of reconnect-looping silently.

- **Tool-usage telemetry.** Every MCP tool call is recorded — to an in-memory
  aggregate served at `GET /api/usage` and to a per-call JSONL log
  (`server/usage-telemetry.jsonl`). A single wrapper at the tool-registration
  chokepoint covers every tool; it captures tool name, ok/error, duration,
  `targetUser`, arg keys, and (for `evaluate`) the truncated body. On by
  default — `FOUNDRY_MCP_USAGE=0` disables it, `FOUNDRY_MCP_USAGE_LOG`
  redirects the log. Local-only: the `/api/usage` aggregate carries no args or
  eval bodies and honors `BRIDGE_TOKEN`.
- **`npm run report` usage report** (`server/scripts/usage-report.mjs`) — reads
  the JSONL and buckets tools into used / never-used / evaluate-share, flags
  never-used tools as merge/cut candidates vs. irreplaceable (Tier-4) vs.
  opt-in infra, and dumps the `evaluate` bodies so calls a dedicated tool
  should have handled are easy to spot. Has a low-sample guard.
- **MCP server `instructions`.** The server now returns orientation guidance in
  the `initialize` handshake, which clients inject into the model's context:
  what the server is, prefer dedicated tools over `evaluate`, the
  action-discriminator tool model, and routing/gates. This is the only guidance
  channel a pure MCP client sees — it never reads AGENTS.md/TOOLS.md.
- **"Auto-connect to MCP server" client setting** (default on). Gates whether an
  interactive client opens the bridge socket on world load; the dedicated
  headless (no-canvas) client always connects regardless. The decision is a
  pure `shouldAutoConnect()` helper.

### Changed

- `evaluate`'s tool description now leads with a "last-resort — prefer a
  dedicated tool" redirect, so the steering reaches clients that don't surface
  server instructions.
- **AGENTS.md** rewritten for the consolidated 67-tool set: pre-consolidation
  tool names replaced with the action-discriminator model and a tool-selection
  policy, the read-only and auto-connect behaviors documented, and a stale
  auto-injected memory block removed.
- **server/TOOLS.md** now documents 11 previously-missing tools
  (`get_actor_items`, `get_scene_placeables`, `get_scene_levels`,
  `set_canvas_level`, `get_settings`, `list_region_behavior_types`,
  `get_debug_snapshot`, `snapshot_actors`, `diff_with`, `call_module_api`,
  `simulate_dialog_response`).

### Fixed

- Token moves over the bridge on Foundry v13+ no longer revert: the move tools
  pass `{ animate: false }` instead of the v12-era `{ animation: { duration: 0 } }`,
  which v13 ignored — animated bridge-driven moves snapped back to origin.

### Internal

- Doc-currency test guards: `docs-tool-names` (AGENTS.md names only registered
  tools) and `docs-tool-coverage` (TOOLS.md documents every tool, no orphans),
  plus unit tests for the telemetry tracker, server instructions, and the
  auto-connect decision.

## [0.17.1] - 2026-06-19

### Fixed

- **Module now loads on Foundry V13 again.** `compatibility.minimum` had been
  raised to `"14"` in v0.11.3, which made Foundry V13 silently drop the package
  at world load — it never registered, so `game.modules.get("foundry-mcp-live")`
  returned `undefined` and the module was invisible despite installing fine in
  The Forge. Lowered `minimum` back to `"13"` (`verified` stays `"14"`).

### Changed

- The five V14-only multi-level-scene tools (`get_scene_levels`,
  `set_canvas_level`, `add_scene_level`, `update_scene_level`,
  `remove_scene_level`) now degrade cleanly on V13 instead of throwing cryptic
  errors: `get_scene_levels` returns a clear "requires v14, single-level world"
  note, and the four mutating tools fail with an explicit
  "requires Foundry v14" message. Everything else is fully supported on V13.
- Server bumped to 0.17.1 in lockstep with the module (no functional server
  change) so the server-version handshake stays quiet after updating.

## [0.17.0] - 2026-06-18

> **Updating the module does NOT update the server.** This release requires
> updating the server too — see [docs/updating-the-server.md](docs/updating-the-server.md).

### Added

- `trace_workflow` tool — preset-driven workflow tracing (snapshot → trace
  hooks → optional trigger → diff) in one call. Presets verified live against
  Midi-QOL v14.0.8 / dnd5e 5.3.3. See [docs/debugging-recipes.md](docs/debugging-recipes.md).
- Server-version handshake: the server reports its version in a `hello-ack`;
  the module warns the GM (toast + dialog with copy-paste update commands and a
  link to the update guide) when the server is older than the module.
- GM-only **"Allow AI to modify the world"** setting — toggles the bridge to
  read-only at runtime with no server restart, within the server's write
  ceiling. `evaluate` remains env-gated.

### Fixed

- Pin `zod` to v3 (`^3.25.76`). zod 4 broke `tools/list` with
  "Cannot read properties of undefined (reading '_zod')", so clients saw zero
  tools.
- Hook-arg serializer now collapses Foundry placeables / PIXI objects to a short
  summary (Midi hook args were dumping the entire token scene-graph).
- `trace_workflow` propagates its window length to the RPC deadline, and its
  Midi damage hooks use the correct v14 names (`isDamaged`/`isHealed`).
- `trace_workflow` Midi presets must be triggered via `use_item` (not
  `request_item_use`, which bypasses Midi) — documented.

### Changed

- **Tool consolidation — BREAKING tool renames, ~96 → ~67 tools.** Same
  capabilities, far fewer entries, to cut LLM context cost and stay under client
  tool-count caps (Cursor ~80). Merged families take an `action`/`target`/
  `phase`/`pathed` discriminator and route to the unchanged Foundry bridge
  handlers (server-side only):
  - `folder`, `actor_write`, `actor_items`, `actor_ownership`, `journal`,
    `scene`, `scene_level`, `region`, `combat` replace their separate
    create/update/delete/activate/etc. tools.
  - `screenshot` (`target`: canvas|dom|scene_grid) replaces screenshot /
    screenshot_dom / capture_scene.
  - `move_token` (`pathed` flag) replaces move_token / move_token_pathed.
  - `request_item_use` (`phase`: full|attack|damage) replaces request_item_use /
    request_attack_roll / request_damage_roll; the `full` phase keeps its
    per-target timeout scaling.
  - Removed redundant `trace_hook` (use `trace_hooks`), `snapshot_actor` /
    `diff_actor` (use `snapshot_actors` / `diff_with`), and the deprecated
    `request_roll_typed` (use `request_check`).

## [0.16.0] - 2026-06-11

### Added

- Background `evaluate` jobs with `job_result` polling and bounded result
  storage.
- `bridge_status` for connection diagnosis without a live Foundry bridge.
- Opt-in `relaunch_client` recovery using a configured local Chrome.
- Guarded `self_test` coverage for Actor, Journal, RollTable, and Scene
  document schema drift.
- Foundry v13/v14 Scene compatibility helpers and automated Node tests.

### Changed

- `evaluate` accepts a 5-180 second server timeout override and returns large
  results through chunkable handles.
- `reload_foundry` includes structured bridge diagnostics when routing or
  reconnecting fails.
- `create_scene` and `update_scene` translate v14 background, texture,
  foreground, level-fog, and fog-exploration fields to Scene Level documents.
- `screenshot` and `capture_scene` flush queued PIXI rendering before capture.
- Bridge hello metadata includes Foundry origin, world, system, and version.
- Server dependencies were refreshed and `puppeteer-core` was added without
  bundling a browser.

### Security

- Client relaunch is disabled by default, restricted to loopback Foundry URLs
  unless explicitly overridden, and accepts passwords only through server
  environment configuration.
- `self_test` requires both write and self-test gates plus `confirm: true`;
  cleanup is restricted to documents carrying the current run flag.
- Background result storage is bounded by TTL, entry count, per-entry size,
  total size, and concurrent job count.

### Verification

- 29 automated tests passed.
- `npm audit` reported zero vulnerabilities.
- Live Foundry 14.363 checks covered a 60-second background evaluation,
  300,059-byte chunked result, v14 Scene field round-trips, guarded self-test
  cleanup, and automated GM client recovery.
