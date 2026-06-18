#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="$REPO_ROOT/server"
SERVICE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
ENV_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/foundry-mcp-live"
SERVICE_PATH="$SERVICE_DIR/foundry-mcp-live.service"
ENV_PATH="$ENV_DIR/server.env"
NODE_PATH="$(command -v node)"
NPM_PATH="$(command -v npm)"

mkdir -p "$SERVICE_DIR" "$ENV_DIR"

if [[ ! -f "$ENV_PATH" ]]; then
  cat > "$ENV_PATH" <<'ENVEOF'
# Foundry MCP Live server environment.
# Defaults are intentionally safe: write/eval/self-test tools are off.
# Uncomment only what you want for this local machine.

# FOUNDRY_MCP_ALLOW_WRITE=1
# FOUNDRY_MCP_ALLOW_EVAL=1
# FOUNDRY_MCP_ALLOW_SELF_TEST=1

# Optional ports/hosts. Defaults are loopback-only.
# FOUNDRY_MCP_PORT=3000
# FOUNDRY_WS_PORT=3001
# FOUNDRY_WS_HOST=127.0.0.1

# Optional diagnostics/relaunch support.
# FOUNDRY_URLS=http://localhost:30000
# FOUNDRY_RELAUNCH_ENABLED=1
# FOUNDRY_RELAUNCH_URL=http://localhost:30000
# FOUNDRY_RELAUNCH_GM_USER=Gamemaster
# FOUNDRY_RELAUNCH_GM_PASSWORD=
# FOUNDRY_CHROME_PATH=/usr/bin/chromium
# FOUNDRY_CHROME_USER_DATA_DIR=%h/.local/share/foundry-mcp-live/chrome-profile

# Optional shared secret. If set, configure the same token in MCP clients and
# in Foundry's browser localStorage.mcpBridgeToken.
# BRIDGE_TOKEN=
ENVEOF
fi

cat > "$SERVICE_PATH" <<EOF
[Unit]
Description=Foundry MCP Live server
Documentation=https://github.com/DimitroffVodka/foundry-mcp-live
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$SERVER_DIR
Environment=PATH=$(dirname "$NODE_PATH"):$(dirname "$NPM_PATH"):/usr/local/bin:/usr/bin:/bin
EnvironmentFile=-$ENV_PATH
ExecStart=$NODE_PATH $SERVER_DIR/server.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
EOF

chmod 644 "$SERVICE_PATH" "$ENV_PATH"

if [[ ! -d "$SERVER_DIR/node_modules" ]]; then
  "$NPM_PATH" --prefix "$SERVER_DIR" install
fi

systemctl --user daemon-reload
systemctl --user enable --now foundry-mcp-live.service

cat <<EOF
Installed and started user service:
  $SERVICE_PATH

Environment file:
  $ENV_PATH

Useful commands:
  systemctl --user status foundry-mcp-live.service
  journalctl --user -u foundry-mcp-live.service -f
  systemctl --user restart foundry-mcp-live.service
  systemctl --user disable --now foundry-mcp-live.service

To start at machine boot before login, enable lingering once:
  sudo loginctl enable-linger $USER
EOF
