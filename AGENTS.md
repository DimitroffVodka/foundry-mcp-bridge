# Foundry MCP Live — Agent Setup (Codex CLI and others)

This repo runs an MCP server that lets a connected agent talk to a live Foundry VTT instance.

## First-message protocol (read before acting)

On your first interaction in this repo, before doing anything else:

1. Call `list_connected_bridges` (the exact tool name in your client may be prefixed, e.g. `mcp_foundry-vtt_list_connected_bridges` in Gemini; use whatever form your client exposes).
2. **If it returns one or more bridges** → the chain is healthy. Expect output shaped like:

   ```json
   {
     "bridges": [
       {
         "userName": "Gamemaster",
         "host": "localhost:30000",
         "isGM": true,
         "targetUser": "Gamemaster@localhost:30000"
       }
     ]
   }
   ```

   **If multiple bridges are returned** (e.g. a local and a hosted Foundry world both running), pick one and thread its `targetUser` field through every subsequent tool call. Do not rely on the default GM route when more than one bridge is connected; both may be GM, and the default may not be the world the user intended.
3. **If the tool isn't in your tool list at all** → your MCP client isn't connected to the server. Re-read the setup sections below and tell the user which step is missing. Do **not** web-search for tool names; the tool list is exposed by the server itself.
4. **If the tool errors or returns an empty array** → the HTTP server is reachable but no Foundry world has the `foundry-mcp-live` module active. Tell the user to open Foundry and verify the module is enabled. Do **not** retry blindly or guess.

The tool list is authoritative. There are no hidden tools, no resources, no prompts. Don't guess names you can't see; don't search the web for documentation you already have access to via `tools/list`.

## This server exposes tools — NOT resources

Common failure mode for fresh agents: looking for MCP **resources** (`resources/list`, `resources/read`) and finding nothing, then concluding the server is empty.

The server registers **zero resources and zero prompts**. Everything is exposed as MCP **tools**. Call tools by name. The full list lives in `server/TOOLS.md`; a few staples:

- `list_actors`, `get_actor`, `snapshot_actor`
- `list_compendiums`, `search_compendium`, `get_compendium_document`
- `get_scene`, `capture_scene`, `screenshot`
- `roll`, `use_item`, `target`, `move_token`
- `get_console_errors`, `reload_foundry`
- `list_connected_bridges` — use this first to confirm Foundry is connected

## Transport

`http://127.0.0.1:3000/mcp` — MCP **Streamable HTTP** transport (single endpoint; POST/GET/DELETE on `/mcp`). Not legacy SSE.

## Codex CLI configuration

Edit `~/.codex/config.toml`:

```toml
[mcp_servers.foundry]
url = "http://127.0.0.1:3000/mcp"
```

Per-tool approval prompts (optional — useful for tools that mutate state or run arbitrary code):

```toml
[mcp_servers.foundry.tools.evaluate]
approval_mode = "approve"

[mcp_servers.foundry.tools.get_actor]
approval_mode = "approve"
```

Restart Codex after editing. The server should appear in the MCP list with tools loaded. The status line `Auth: Unsupported` is **normal** for local unauthenticated use — it only matters if `BRIDGE_TOKEN` is set on the server (see below).

## Prerequisites for connection

1. MCP server is running: `cd server && npm start` (or `server\start.bat` on Windows). Default port 3000.
2. Foundry VTT is open with the `foundry-mcp-live` module active. The module connects to the server's WebSocket bridge on port 3001.
3. `list_connected_bridges` returns at least one bridge — confirms Foundry-side handshake worked.

## If `BRIDGE_TOKEN` is set

The server's env may set `BRIDGE_TOKEN=<secret>`. In that case every request to `/mcp` must include `Authorization: Bearer <secret>`. Codex doesn't have a per-server header config — start the server without `BRIDGE_TOKEN` for local use, or use the stdio proxy (`server/proxy.mjs`) which can read the token from env.

## Multi-GM routing

If multiple Foundry users with the same name are connected (e.g. two GMs on different worlds), use the `targetUser` parameter on tool calls. Get valid targets from `list_connected_bridges` and prefer the returned `targetUser` value. Examples: `"Gamemaster@localhost:30000"`, `"Gamemaster@shadowfoundry.online"`. Omit `targetUser` only when the default GM route is definitely the intended world.

## Mutation caution

Some tools mutate live Foundry state — they will change what GMs and players see in the open world. Before calling any of these, identify the target token/actor explicitly and pass `targetUser` if multiple bridges are connected. Read-only tools should come first to confirm you have the right target.

**Mutating tools include** (not exhaustive — check the tool description): `move_token`, `move_token_pathed`, `update_token`, `delete_tokens`, `toggle_token_condition`, `use_item`, `roll`, `reload_foundry`, `target`, `click`, `simulate_dialog_response`, and `evaluate` if enabled.

**World-authoring tools** (only present when `FOUNDRY_MCP_ALLOW_WRITE=1` on the server): `create_folder`, `create_actor`, `create_actor_from_compendium`, `add_items_to_actor`, `create_journal_entry`, `update_journal_page`. These create persistent world data — actors, journals, folders. If they're not in your tool list, the server's write gate is off and that's intentional; tell the user to set the env var rather than retrying.

**Read-only safe to explore with:** `list_*`, `get_*`, `snapshot_*`, `diff_*`, `search_compendium`, `screenshot`, `capture_scene`, `get_console_errors`, `trace_*`.

## Quick smoke test

After configuration, in order. If multiple bridges are connected, pick one `targetUser` from step 1 and reuse it on steps 2–4.

1. `list_connected_bridges` — non-empty means Foundry is reachable. Grab the `targetUser` you want to use.
2. `get_game_info` (with `targetUser`) — confirms Foundry version, system id, active world, and active users in one read-only call.
3. `list_actors` (with same `targetUser`) — confirms tool calls reach Foundry and data comes back.
4. `get_scene` (with same `targetUser`) — sanity check on read-only state queries against the active scene.

If those four work, the integration is healthy.


<claude-mem-context>
# Memory Context

# claude-mem status

This project has no memory yet. The current session will seed it; subsequent sessions will receive auto-injected context for relevant past work.

Memory injection starts on your second session in a project.

`/learn-codebase` is available if the user wants to front-load the entire repo into memory in a single pass (~5 minutes on a typical repo, optional). Otherwise memory builds passively as work happens.

Live activity: http://localhost:37777
How it works: `/how-it-works`

This message disappears once the first observation lands.
</claude-mem-context>