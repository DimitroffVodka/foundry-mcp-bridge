# Example client configurations

Ready-to-paste config snippets for each MCP-compatible client. The MCP server must be running (`npm start` in `server/`) before any client connects.

| File | Target | Where to put it |
|------|--------|-----------------|
| [`claude_desktop_config.json`](claude_desktop_config.json) | Claude Desktop | `%APPDATA%\Claude\claude_desktop_config.json` (Win) / `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS). Replace the path with the absolute path to your `proxy.mjs`. |
| [`codex-config.toml`](codex-config.toml) | Codex CLI | Append to `~/.codex/config.toml`. |
| [`gemini-settings.json`](gemini-settings.json) | Gemini CLI | Place at `<your-project>/.gemini/settings.json` for project-level wiring. |

For Claude Code, use HTTP directly: `claude mcp add --transport http foundry-vtt http://127.0.0.1:3000/mcp`. (Stdio via `proxy.mjs` also works if you prefer.)
