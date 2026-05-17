# Foundry MCP Live

Connect any MCP-compatible AI client (Claude Desktop, Claude Code, Codex CLI, Gemini CLI) directly to a running Foundry VTT instance. Get live access to actors, compendiums, modules, console errors, and the full game API — no copy-pasting data, no API tokens.

> The Foundry module id is `foundry-mcp-live`. The GitHub repo is named `foundry-mcp-bridge` for historical reasons; both refer to the same project. The id was renamed in v0.7.0 to avoid a collision with an unrelated module in Foundry's package directory.

## Architecture

```
                          Claude Desktop ─(stdio)─► proxy.mjs ──┐
                                                                │
                          Claude Code  ─────(HTTP)─────────────►│
                                                                ├──► MCP Server
                          Codex CLI    ─────(HTTP)─────────────►│  (HTTP:3000)
                                                                │      │
                          Gemini CLI   ─────(HTTP)─────────────►┘      │
                                                                       ▼
                                                              ◄─(WS:3001)─►
                                                              Foundry browser
```

- **MCP Server** (`server/server.js`, Node.js) — Runs locally on `http://127.0.0.1:3000/mcp` (MCP HTTP transport) and `ws://127.0.0.1:3001` (Foundry bridge). Must be started manually and kept running.
- **Foundry Module** (`module/`, browser JS) — Connects to the WebSocket server on load. Handles tool requests against the live `game` object.
- **stdio proxy** (`server/proxy.mjs`) — Bridge for clients that only speak stdio MCP (Claude Desktop, Claude Code).

## Repo layout

```
foundry-mcp-bridge/
├── module/    ← Foundry VTT module (copy/symlink into Foundry's modules dir)
└── server/    ← Node.js MCP server (run locally with npm start)
```

## Setup

### 1. Clone and install

```bash
git clone https://github.com/DimitroffVodka/foundry-mcp-bridge.git
cd foundry-mcp-bridge/server
npm install
```

### 2. Install the Foundry module

In Foundry: **Add-on Modules → Install Module** → paste this manifest URL:

```
https://github.com/DimitroffVodka/foundry-mcp-bridge/releases/latest/download/module.json
```

Foundry downloads and installs it like any other module. Activate it in your world's Module Management.

<details>
<summary>Manual install (if you can't use the manifest URL)</summary>

Copy or symlink the `module/` folder from this repo into your Foundry modules directory, renaming it to `foundry-mcp-live`:

- **Windows:** `%localappdata%\FoundryVTT\Data\modules\foundry-mcp-live`
- **Linux:** `/home/foundry/foundrydata/Data/modules/foundry-mcp-live`
- **macOS:** `~/Library/Application Support/FoundryVTT/Data/modules/foundry-mcp-live`

</details>

### 3. Start the MCP server

The server is HTTP-based and must be running before any client connects:

```bash
cd server
npm start
# or on Windows: server\start.bat
```

You should see:
```
[foundry-mcp] WebSocket server listening on ws://localhost:3001
MCP HTTP server  listening on http://127.0.0.1:3000/mcp
```

Keep this terminal open. The server auto-reloads tool files but other changes need a restart.

### 4. Configure your AI client

Pick one or more. **All four can connect simultaneously** to the same running server.

#### Claude Desktop

Edit `%APPDATA%\Claude\claude_desktop_config.json` (Windows) or `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "foundry-vtt": {
      "command": "node",
      "args": ["C:\\path\\to\\foundry-mcp-bridge\\server\\proxy.mjs"]
    }
  }
}
```

Use the **absolute path** to `proxy.mjs`. Restart Claude Desktop.

#### Claude Code

Claude Code supports HTTP MCP natively, so no proxy is needed:

```bash
claude mcp add --transport http foundry-vtt http://127.0.0.1:3000/mcp
```

Confirm with `claude mcp list` — should show `foundry-vtt: http://127.0.0.1:3000/mcp (HTTP) - ✓ Connected`.

(Stdio fallback via `proxy.mjs` also works if you prefer: `claude mcp add foundry-vtt -- node /absolute/path/to/server/proxy.mjs`.)

#### Codex CLI

Edit `~/.codex/config.toml`:

```toml
[mcp_servers.foundry]
url = "http://127.0.0.1:3000/mcp"
```

That's the minimum. To require explicit approval for specific tools, add per-tool rules:

```toml
[mcp_servers.foundry.tools.evaluate]
approval_mode = "approve"

[mcp_servers.foundry.tools.get_actor]
approval_mode = "approve"
```

#### Gemini CLI

Project-level (recommended) — create `.gemini/settings.json` in your project root:

```json
{
  "mcpServers": {
    "foundry-mcp-server": {
      "url": "http://127.0.0.1:3000/mcp"
    }
  }
}
```

Or run `gemini mcp add foundry-mcp-server http://127.0.0.1:3000/mcp` from the project directory.

### 5. Connect

1. Make sure the MCP server is running (step 3).
2. Open your Foundry VTT world with the bridge module active. You should see a notification: "MCP Bridge connected to Claude Desktop".
3. Launch your AI client. The Foundry tools should appear in its tool list.

## Available Tools

| Tool | Description |
|------|-------------|
| `get_game_info` | System, world, version, connected users |
| `list_actors` | All actors (filterable by type/folder) |
| `get_actor` | Full actor data by id or name |
| `get_selected_token` | Currently selected token + actor |
| `get_active_effects` | Active Effects on a specific actor |
| `list_modules` | Installed modules (active by default) |
| `list_compendiums` | All compendium packs with metadata |
| `search_compendium` | Text search within a pack |
| `get_compendium_document` | Full document from a pack |
| `list_items` | World-level items |
| `get_item` | Full item data by id or name |
| `get_scene` | Active scene, grid, all token positions |
| `get_data_model` | System data model template |
| `list_journals` | Journal entries |
| `list_tables` | Roll tables |
| `list_macros` | Macro list with preview |
| `get_macro` | Full macro source code |
| `get_console_errors` | Recent console errors/warnings |
| `evaluate` | Run arbitrary JS in Foundry context |
| `list_connected_bridges` | Show which Foundry users are connected (server-local tool) |

See [server/TOOLS.md](server/TOOLS.md) for full tool schemas and arguments.

## Multi-user routing

Every tool accepts an optional `targetUser` parameter. The default is the GM. To run a tool as a specific player, pass that player's exact user name:

```js
evaluate({ expression: "game.user.name", targetUser: "PlayerName" })
```

The MCP server tracks every connected Foundry user via an identity frame sent on connect (`{ type: "hello", userId, userName, isGM }`). Use `list_connected_bridges` to see who's reachable. Foundry's permission rules apply — a player-targeted call to a GM-only API will surface the same error a player would see in their own console.

Older bridges (v0.1.x) that don't send the hello frame are treated as the legacy GM, so unupgraded installs keep working.

## Debugging

From the Foundry browser console, the bridge exposes a global:

```js
mcpBridge.ws          // WebSocket instance
mcpBridge.handlers    // Handler map (callable locally for testing)
mcpBridge.errors      // Error buffer contents
mcpBridge.reconnect() // Force reconnect
```

The MCP server logs to stderr in the terminal where you started it.

To test connectivity without a client:

```bash
curl -i -X POST http://127.0.0.1:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
```

You should get a 200 with an `mcp-session-id` header.

## Environment variables

| Var | Default | Purpose |
|-----|---------|---------|
| `FOUNDRY_WS_PORT` | `3001` | WebSocket port the Foundry module connects to |
| `FOUNDRY_MCP_PORT` | `3000` | HTTP port MCP clients connect to |
| `FOUNDRY_MCP_URL` | `http://127.0.0.1:3000/mcp` | Used by `proxy.mjs` to find the HTTP server |
| `FOUNDRY_MCP_ALLOW_EVAL` | `0` | Set to `1` to enable the `evaluate` tool (arbitrary JS in Foundry context). See [SECURITY.md](SECURITY.md). |
| `BRIDGE_TOKEN` | (unset) | Shared secret. If set, all MCP HTTP requests must send `Authorization: Bearer <token>` and the Foundry module must store the same value in `localStorage.mcpBridgeToken`. See [SECURITY.md](SECURITY.md). |

## Notes

- The WebSocket connection auto-reconnects every 5 seconds if Foundry is reloaded. The hello frame is re-sent each time.
- Console error capture starts when the module loads — errors before the `ready` hook are missed.
- The `evaluate` tool runs arbitrary JS in the Foundry client context — disabled by default. Enable with `FOUNDRY_MCP_ALLOW_EVAL=1`.
- Both ports bind to `127.0.0.1` only — not exposed to the network.
- No API tokens are consumed by the AI clients. All communication is local: AI client ↔ MCP server ↔ Foundry browser.
- See [SECURITY.md](SECURITY.md) for the threat model and opt-in auth.

## Releasing a new version

1. Bump `version` in [module/module.json](module/module.json) and [server/package.json](server/package.json).
2. Commit, then tag and push: `git tag v0.5.2 && git push --tags`.
3. The [release workflow](.github/workflows/release.yml) builds `module.zip` and publishes a GitHub Release with `module.json` + `module.zip` attached. The manifest URL `releases/latest/download/module.json` then points at the new version automatically, so Foundry's update check picks it up.

## License

MIT
