#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ---------------------------------------------------------------------------
# Optional features (env-var gates). All are off by default in the codebase.
# Export any of these in your shell, systemd EnvironmentFile, or uncomment
# lines here for a personal local launcher.
# ---------------------------------------------------------------------------
export FOUNDRY_MCP_ALLOW_WRITE=1
export FOUNDRY_MCP_ALLOW_EVAL=1
# export FOUNDRY_MCP_ALLOW_SELF_TEST=1
# export FOUNDRY_RELAUNCH_ENABLED=1

printf 'Starting Foundry MCP Server...\n'
printf 'MCP endpoint : http://127.0.0.1:%s/mcp\n' "${FOUNDRY_MCP_PORT:-3000}"
printf 'Foundry WS   : ws://%s:%s\n' "${FOUNDRY_WS_HOST:-127.0.0.1}" "${FOUNDRY_WS_PORT:-3001}"
if [[ "${FOUNDRY_MCP_ALLOW_WRITE:-}" == "1" ]]; then
  printf 'World writes : ENABLED (create_folder, create_actor, create_journal_entry, etc.)\n'
fi
if [[ "${FOUNDRY_MCP_ALLOW_EVAL:-}" == "1" ]]; then
  printf 'evaluate     : ENABLED (arbitrary JS in Foundry context)\n'
fi
printf '\n'

exec node "$SCRIPT_DIR/server.js"
