# Example client configurations

Ready-to-paste config snippets for each MCP-compatible client. The MCP server must be running (`npm start` in `server/`) before any client connects.

| File | Target | Where to put it |
|------|--------|-----------------|
| [`claude_desktop_config.json`](claude_desktop_config.json) | Claude Desktop | `%APPDATA%\Claude\claude_desktop_config.json` (Win) / `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS). Replace the path with the absolute path to your `proxy.mjs`. |
| [`codex-config.toml`](codex-config.toml) | Codex CLI | Append to `~/.codex/config.toml`. |
| [`gemini-settings.json`](gemini-settings.json) | Gemini CLI | Place at `<your-project>/.gemini/settings.json` for project-level wiring. |

For Claude Code, use `claude mcp add foundry-vtt -- node /absolute/path/to/server/proxy.mjs` — same proxy.mjs as Claude Desktop.
