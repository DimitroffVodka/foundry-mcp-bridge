@echo off

REM ---------------------------------------------------------------------------
REM Optional features (env-var gates). Both are off by default in the codebase.
REM Uncomment the EVAL line if you want the `evaluate` tool (arbitrary JS in
REM the Foundry browser context).
REM ---------------------------------------------------------------------------
set FOUNDRY_MCP_ALLOW_WRITE=1
set FOUNDRY_MCP_ALLOW_EVAL=1

echo Starting Foundry MCP Server...
echo MCP endpoint : http://127.0.0.1:3000/mcp
echo Foundry WS   : ws://127.0.0.1:3001
if "%FOUNDRY_MCP_ALLOW_WRITE%"=="1" echo World writes : ENABLED (create_folder, create_actor, create_journal_entry, etc.)
if "%FOUNDRY_MCP_ALLOW_EVAL%"=="1"  echo evaluate     : ENABLED (arbitrary JS in Foundry context)
echo.
echo Keep this window open while using Claude Desktop or Claude Code CLI.
echo Close it to stop the server.
echo.
node "%~dp0server.js"
pause
