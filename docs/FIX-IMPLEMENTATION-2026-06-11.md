# Fix Implementation Report (2026-06-11)

Implementation record for
[FIX-PLAN-2026-06-11.md](./FIX-PLAN-2026-06-11.md).

## Status

All P1-P5 findings in the fix plan are included in the v0.16.0 release and
were exercised against Foundry 14.363 in the `shadowdark-test` world.

## Findings Addressed

| Finding | Implemented change |
|---|---|
| P1 - Long-running `evaluate` | Added a clamped per-call `timeoutMs`, background evaluation jobs, and `job_result` polling. |
| P2 - Dead GM client | Added `bridge_status`, structured reload failure diagnostics, and opt-in `relaunch_client` recovery through a configured Chrome executable. |
| P3 - Foundry v14 schema drift | Added v13/v14 Scene compatibility translation, a write-surface compatibility audit, and guarded `self_test`. |
| P4 - Background-tab canvas captures | Added a shared PIXI ticker flush before `screenshot` and `capture_scene`. |
| P5 - Quality of life | Added bounded large-result handles and included bridge diagnosis in server-local routing/reconnect failures. |

## Tools And Interfaces

### Updated `evaluate`

- `timeoutMs` is optional and clamped to 5,000-180,000ms.
- `background: true` starts work in the Foundry browser and immediately
  returns `{ jobId, status, startedAt }`.
- Normal results return `{ result, evalMs }`.
- Results larger than 256 KiB return
  `{ resultHandle, status, totalBytes, totalChars, preview }`.
- The default synchronous RPC timeout remains 15 seconds when `timeoutMs` is
  omitted.

### New `job_result`

Reads both background jobs and oversized result handles.

- Supports `waitMs` from 0-10,000ms for bounded polling.
- Supports chunk reads with `offset` and `length` up to 65,536 characters.
- Settled entries remain retryable until explicit deletion or TTL expiry.
- Running JavaScript cannot be canceled; deletion is allowed after settlement.
- Storage is bounded to 30 minutes, 50 entries, 8 MiB per entry, 32 MiB
  total, and 10 concurrent running jobs.

### New `bridge_status`

Runs entirely in the MCP server, so it works without a connected bridge.

- Reports current and last-seen bridge metadata.
- Probes bridge-advertised and `FOUNDRY_URLS` Foundry origins.
- Classifies the connection as `bridge-connected`,
  `foundry-up-no-bridge`, `foundry-up-no-users`, `foundry-down`, or
  `unknown`.
- The same diagnosis is included when `reload_foundry` cannot route or
  reconnect.

### New `relaunch_client`

Provides opt-in recovery when the configured GM browser is no longer
connected.

- Starts the configured Chrome/Chromium executable through `puppeteer-core`.
- Opens `/join`, selects the configured GM, submits the environment-only
  password, and waits for the bridge to register.
- Returns immediately without launching Chrome if the configured GM bridge is
  already connected.
- Accepts only loopback Foundry URLs by default. Remote relaunch requires an
  explicit opt-in.
- Credentials are not accepted as tool parameters and are redacted from
  returned errors.

### New `self_test`

Runs a guarded schema-drift smoke test after a Foundry core update.

- Requires `confirm: true`.
- Creates uniquely named and flagged Actor, JournalEntry/Page,
  RollTable/TableResult, and Scene/Level documents.
- Round-trips representative fields, including
  `TableResult.description` and v14 Level-backed Scene fields.
- Always attempts reverse-order cleanup in `finally`.
- Deletes a document only when its `foundry-mcp-live.selfTestRun` flag still
  matches the current run.
- Returns `{ runId, pass, checks, cleanup }`.

## Foundry Scene Compatibility

`create_scene` and `update_scene` now translate fields according to the
Foundry generation:

| Input | Foundry v13 | Foundry v14 |
|---|---|---|
| `backgroundColor` | `Scene.backgroundColor` | Default `Level.background.color` |
| `background.src`, tint, alpha | `Scene.background` | Default `Level.background` |
| Background anchors, offsets, fit, scale, rotation | `Scene.background` | Default `Level.textures` |
| `foreground` | `Scene.foreground` | Default `Level.foreground` |
| `levelFog` | Rejected as v14-only | Default `Level.fog` |
| `fogExploration` | Legacy Scene field | `Scene.fog.mode` 0 or 1 |
| Explicit `fog` object | `Scene.fog` | `Scene.fog`, taking precedence over the compatibility boolean |

The Level resolver uses `defaultLevel0000`, then `scene.initialLevel`, then
the first available Level. Missing Level documents produce an explicit error
instead of silently dropping the requested fields.

The write-surface audit also confirmed:

- Actor ownership names are resolved to Foundry ownership levels before
  updating documents.
- No authoring path calls the removed `pack.configure({label: ...})` shape.
- RollTable verification uses `TableResult.description`, not legacy `.text`.
- Snapshot and diff tools are read-only and do not require schema translation.

## Security And Configuration

All powerful capabilities remain absent from the MCP tool list unless their
environment gates are enabled.

| Variable | Purpose |
|---|---|
| `FOUNDRY_MCP_ALLOW_EVAL=1` | Registers `evaluate` and `job_result`. |
| `FOUNDRY_MCP_ALLOW_WRITE=1` | Registers persistent world-authoring tools. |
| `FOUNDRY_MCP_ALLOW_SELF_TEST=1` | Registers `self_test` when the write gate is also enabled. |
| `FOUNDRY_URLS` | Supplies restart-safe Foundry origins for `bridge_status`. |
| `FOUNDRY_RELAUNCH_ENABLED=1` | Registers `relaunch_client`. |
| `FOUNDRY_RELAUNCH_URL` | Explicit Foundry origin to join. |
| `FOUNDRY_RELAUNCH_GM_USER` | Exact GM user name selected on the join page. |
| `FOUNDRY_RELAUNCH_GM_PASSWORD` | Optional password read only from the server environment. |
| `FOUNDRY_CHROME_PATH` | Absolute Chrome/Chromium executable path. |
| `FOUNDRY_CHROME_USER_DATA_DIR` | Optional dedicated browser profile directory. |
| `FOUNDRY_RELAUNCH_ALLOW_REMOTE=1` | Allows a non-loopback relaunch URL. |

`puppeteer-core` was added as a server dependency. It does not download a
browser; `FOUNDRY_CHROME_PATH` must identify an installed executable.

## Files Changed

### Added

- `module/scripts/canvas-render.js`
- `module/scripts/runtime-jobs.js`
- `module/scripts/scene-compat.js`
- `module/scripts/self-test.js`
- `server/lib/bridge-status.js`
- `server/lib/client-relauncher.js`
- `server/test/*.test.js` coverage for status, canvas flushing, runtime jobs,
  timeout forwarding, Scene compatibility, self-test cleanup, and relaunching.

### Materially Updated

- `module/scripts/bridge.js` integrates the new runtime, Scene, self-test, and
  capture behavior.
- `server/tools/runtime.js`, `server/tools/server-local.js`, and
  `server/tools/world-authoring.js` register the new interfaces and schemas.
- `server/lib/bridges.js` and `server/lib/config.js` retain bridge metadata and
  expose the new environment configuration.
- `server/package.json` and `server/package-lock.json` add the test command,
  `puppeteer-core`, and audited dependency updates.
- `README.md`, `SECURITY.md`, and `server/TOOLS.md` document usage,
  compatibility, and security boundaries.

## Verification Evidence

### Automated

- `npm test` in `server/`: **29 passed, 0 failed**.
- `npm audit --json`: **0 vulnerabilities**.
- `node --check` succeeded for all changed and added JavaScript entry points.
- `git diff --check` reported no whitespace errors.
- Inverse greps found zero occurrences of:
  - `this.senderId`
  - `CONFIG.DiceSD.RollDialog`
  - legacy `renderChatMessage(`
  - `Roll.safeEval(...)` expressions using `Math.*`

### Live Foundry 14.363

- A 16-second synchronous evaluation completed with `timeoutMs: 60000` and
  reported `evalMs: 16229.7`.
- A deliberate 60-second background evaluation completed through
  `job_result` with `evalMs: 60635.5`.
- A 300,059-byte evaluation result returned a handle, was read in bounded
  chunks, and was explicitly deleted.
- Scene create/update readback confirmed Level background color, texture
  offsets, scale, rotation, foreground tint, level-fog tint, and
  `Scene.fog.mode`.
- Actor ownership accepted `"NONE"` and `"OBSERVER"` and read those friendly
  levels back correctly; the temporary Actor was deleted.
- `self_test` returned `pass: true` with 4/4 checks and 4/4 guarded cleanups.
- A follow-up flagged-document scan returned `[]`.
- After the GM left the world, `bridge_status` reported
  `foundry-up-no-users`; `relaunch_client` restored `bridge-connected` in
  11,689ms.
- The final five-minute console-error query returned zero entries.
- Deployed hashes for `bridge.js` and all four new module helper scripts
  matched the repository copies.

## Release

- Release version: `v0.16.0`.
- Release contents: P1-P5 implementation, automated tests, public
  documentation, security guidance, and this implementation record.
- Packaging: the tag-triggered GitHub Actions workflow builds `module.zip`
  from `module.json`, `scripts/`, and `lib/`, then publishes both artifacts.
