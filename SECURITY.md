# Security model

## Threat model

This is a **local developer tool**, not a production-grade service. The default install assumes:

- The MCP server and AI client run on the **same physical machine**.
- That machine is **single-user** (typically your gaming/dev PC).
- The Foundry browser session runs in **your** browser.

Both ports bind to `127.0.0.1` only — nothing is exposed to the LAN or the internet by default.

If your environment doesn't fit those assumptions (shared workstation, public terminal, multi-tenant VPS), turn on the auth options below.

## What the bridge can do

The bridge exposes a set of MCP tools that read and modify Foundry state, plus an optional `evaluate` tool that runs arbitrary JavaScript in your Foundry browser context. Tools can:

- Read every actor, item, journal, scene, compendium entry, and console log.
- Move tokens, open/close doors, toggle conditions, target tokens.
- (Opt-in) Execute arbitrary JS as the logged-in Foundry user (typically the GM).

Treat the MCP endpoint with the same trust you'd give a logged-in GM browser session.

## Built-in mitigations

- **Loopback binding.** Both HTTP (3000) and WebSocket (3001) bind to `127.0.0.1`.
- **CORS lockdown.** The HTTP server rejects any `Origin` header that isn't `localhost` / `127.0.0.1` / `[::1]`. CLI clients (no `Origin`) and the proxy.mjs stdio bridge are unaffected. A malicious site visited in another tab cannot POST to the MCP endpoint with a custom JSON Content-Type without a preflight, and the preflight gets a 403.
- **`evaluate` is opt-in.** The most dangerous tool is disabled unless `FOUNDRY_MCP_ALLOW_EVAL=1` is set in the server's environment.
- **Vendored dependencies.** `html2canvas` is bundled in `module/lib/`; the module never fetches code from a CDN at runtime.

## Opt-in: token auth

Set a shared secret when you want to require auth for every client and bridge:

```bash
# server side
BRIDGE_TOKEN=$(openssl rand -hex 32) npm start    # macOS/Linux
```

```powershell
# Windows PowerShell
$env:BRIDGE_TOKEN = -join ((1..64) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })
npm start
```

With `BRIDGE_TOKEN` set, every connection must authenticate:

| Client | How to pass the token |
|---|---|
| Claude Desktop / Code (via `proxy.mjs`) | Set the same `BRIDGE_TOKEN` env var in the shell that spawns proxy.mjs — proxy.mjs forwards it as `Authorization: Bearer …` |
| Codex CLI | `~/.codex/config.toml` → `[mcp_servers.foundry] http_headers = { Authorization = "Bearer YOUR_TOKEN" }` |
| Gemini CLI | `.gemini/settings.json` → add `"headers": { "Authorization": "Bearer YOUR_TOKEN" }` next to the `url` |
| Claude Code (HTTP transport) | `claude mcp add --transport http foundry-vtt http://127.0.0.1:3000/mcp -H "Authorization: Bearer YOUR_TOKEN"` |
| Foundry browser module | In Foundry's browser console: `localStorage.setItem("mcpBridgeToken", "YOUR_TOKEN")` — then reload Foundry |

Without the matching token: HTTP returns `401`, WebSocket is closed with code `1008`.

## Opt-in: enable `evaluate`

```bash
FOUNDRY_MCP_ALLOW_EVAL=1 npm start
```

You probably want this enabled for serious work — most module debugging benefits from `evaluate`. The opt-in is so that someone trying the bridge for the first time doesn't accidentally hand RCE to a misbehaving AI.

## Known residual risks

- **Read-out of sensitive state.** Even without `evaluate`, tools like `get_actor`, `get_console_errors`, and `snapshot_actor` expose the full game state, including GM-only flags and notes. If a connected AI client decides to read everything and exfiltrate it, the bridge will let it. Mitigation: only connect AI clients you trust to handle your game data.
- **Hot-reload of `server/tools/`.** If an attacker can write to the filesystem, they can drop a malicious tool file and the server will pick it up on next request. Not a new attack surface — at that level of access they already own you.
- **Multi-user routing.** With `targetUser` set, a tool runs in *that user's* browser context with their permissions. The server enforces routing but not authorization on which user a client is allowed to target. If you connect a non-trusted client and trust it to act as a specific player, it can act as ANY connected user.

## Reporting

If you find a vulnerability, open a private GitHub security advisory on the repo rather than filing a public issue.
