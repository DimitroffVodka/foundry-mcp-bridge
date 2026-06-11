# Changelog

All notable changes to Foundry MCP Live are documented in this file.

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
