@echo off
echo Starting Foundry MCP Server...
echo MCP endpoint : http://127.0.0.1:3000/mcp
echo Foundry WS   : ws://127.0.0.1:3001
echo.
echo Keep this window open while using Claude Desktop or Claude Code CLI.
echo Close it to stop the server.
echo.
node "%~dp0server.js"
pause
