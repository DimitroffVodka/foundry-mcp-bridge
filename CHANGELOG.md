# Changelog

All notable changes to Foundry MCP Live are documented in this file.

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
