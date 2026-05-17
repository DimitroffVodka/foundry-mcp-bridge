# Foundry MCP Bridge

Connect Claude Desktop directly to a running Foundry VTT instance. Claude gets live access to actors, compendiums, modules, console errors, and the full game API — no copy-pasting data, no API tokens.

## Architecture

```
Claude Desktop ←(stdio)→ MCP Server ←(WebSocket:3001)→ Foundry Module
```

- **MCP Server** (Node.js, in `server/`) — Claude Desktop spawns this. It runs a WebSocket server on `localhost:3001`.
- **Foundry Module** (browser JS, in `module/`) — Connects to the WebSocket server. Handles tool requests against the live `game` object.

## Repo layout

```
foundry-mcp-bridge/
├── module/    ← Foundry VTT module (copy/symlink into Foundry's modules dir)
└── server/    ← Node.js MCP server (runs locally, spawned by Claude Desktop)
```

## Setup

### 1. Clone the repo

```bash
git clone https://github.com/DimitroffVodka/foundry-mcp-bridge.git
cd foundry-mcp-bridge
```

### 2. Install the MCP server

```bash
cd server
npm install
cd ..
```

### 3. Install the Foundry module

Copy or symlink the `module/` folder into your Foundry modules directory, renaming it to `foundry-mcp-bridge`:

**Windows (local Foundry):**
```
%localappdata%\FoundryVTT\Data\modules\foundry-mcp-bridge
```

**Linux:**
```
/home/foundry/foundrydata/Data/modules/foundry-mcp-bridge
```

Then activate the module in your world's Module Management settings.

### 4. Configure Claude Desktop

Edit your Claude Desktop config file:

**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

Add the MCP server:

```json
{
  "mcpServers": {
    "foundry-vtt": {
      "command": "node",
      "args": ["C:\\path\\to\\foundry-mcp-bridge\\server\\server.js"]
    }
  }
}
```

Use the full absolute path to `server/server.js`. Restart Claude Desktop after editing.

### 5. Connect

1. Start Claude Desktop (it will spawn the MCP server automatically)
2. Open your Foundry VTT world with the bridge module active
3. You should see a notification in Foundry: "MCP Bridge connected to Claude Desktop"
4. The Foundry MCP tools will appear in Claude Desktop's tool list

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

See [server/TOOLS.md](server/TOOLS.md) for full tool schemas.

## Debugging

From the Foundry browser console, the bridge exposes a global:

```js
mcpBridge.ws          // WebSocket instance
mcpBridge.handlers    // Handler map (callable locally for testing)
mcpBridge.errors      // Error buffer contents
mcpBridge.reconnect() // Force reconnect
```

The MCP server logs to stderr (visible in Claude Desktop's developer tools or in the terminal if run manually):

```bash
# Test the server standalone
node server/server.js
# You'll see: [foundry-mcp] WebSocket server listening on ws://localhost:3001
```

## Multi-user routing (v0.2.0+)

The bridge sends an identity frame to the MCP server on connect (`{ type: "hello", userId, userName, isGM }`). The server tracks every connected Foundry user, so MCP tool calls can target a specific user via the optional `targetUser` parameter.

The default route is the GM. To run a tool as a specific player, pass that player's exact user name:

```js
evaluate({ expression: "game.user.name", targetUser: "PlayerName" })
```

Use `list_connected_bridges` (a server-local MCP tool) to see who's currently reachable. Foundry's permission rules apply.

Older bridges (v0.1.x and earlier) that don't send the hello frame are treated by the server as the legacy GM, so unupgraded installs keep working.

## Notes

- The WebSocket connection auto-reconnects every 5 seconds if Foundry is reloaded. The hello frame is re-sent each time the connection opens.
- Console error capture starts when the module loads — errors before `ready` hook are missed.
- The `evaluate` tool runs arbitrary JS in the Foundry client context. It's the most powerful tool and the most dangerous. Claude will use it when the structured tools don't cover what's needed.
- The MCP server binds to `localhost` only — not exposed to the network.
- No API tokens are consumed. All communication is local: Claude Desktop ↔ MCP server ↔ Foundry.

## License

MIT
