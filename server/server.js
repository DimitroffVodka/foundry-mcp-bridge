/**
 * Foundry MCP Server — HTTP transport
 *
 * Entry point. Launches:
 *   - the Foundry-bridge WebSocket server (lib/bridges.js)
 *   - the MCP HTTP server with per-session McpServer instances
 *   - the hot-reload watcher (lib/hot-reload.js)
 *
 * All real logic lives under lib/ and tools/. This file only wires things
 * up and owns the HTTP/MCP transport bookkeeping.
 *
 * Environment variables:
 *   FOUNDRY_WS_PORT   – WebSocket port for Foundry bridge  (default: 3001)
 *   FOUNDRY_MCP_PORT  – HTTP port for MCP clients          (default: 3000)
 */

import { McpServer }                      from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport }  from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp }            from "@modelcontextprotocol/sdk/server/express.js";
import { randomUUID }                     from "crypto";

import { log }                            from "./lib/log.js";
import { HTTP_PORT }                      from "./lib/config.js";
import { startBridgeServer }              from "./lib/bridges.js";
import { startHotReloadWatcher }          from "./lib/hot-reload.js";
import { registerTools }                  from "./tools/index.js";

// Start accepting Foundry bridge connections immediately. Bridges that arrive
// before the first MCP client are fine — the bridges Map is module-level state
// shared with `routeBridge`.
startBridgeServer();

// ---------------------------------------------------------------------------
// HTTP / MCP server — stateful session management so multiple clients work
// ---------------------------------------------------------------------------
// Each session: { transport, mcp }. The hot-reload watcher iterates `mcp`
// values to upsert tool registrations across every active session on a
// tools/*.js change.
const sessions = new Map(); // sessionId → { transport, mcp }

// Hot-reload: file watcher on tools/ that re-imports and re-registers tools
// across every active session whenever a tool file changes. See
// lib/hot-reload.js for scope (handler-body + schema/desc edits live;
// lib/* changes still need a server restart).
startHotReloadWatcher(() => [...sessions.values()].map(s => s.mcp));

const app = createMcpExpressApp();

// Handle all MCP traffic (POST for messages, GET for SSE streams, DELETE to close)
app.all("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];

  // --- Existing session ---
  if (sessionId && sessions.has(sessionId)) {
    const { transport } = sessions.get(sessionId);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  // --- Reject non-init requests that have no session ---
  if (req.method !== "POST") {
    res.status(400).json({ error: "No active session. Send an initialize request first." });
    return;
  }

  // --- New session (initialize) ---
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      sessions.set(id, { transport, mcp });
      log(`Session opened  [${id}]  (${sessions.size} active)`);
    },
  });

  transport.onclose = () => {
    if (transport.sessionId) {
      sessions.delete(transport.sessionId);
      log(`Session closed  [${transport.sessionId}]  (${sessions.size} active)`);
    }
  };

  const mcp = new McpServer({ name: "foundry-vtt", version: "0.3.0" });
  await registerTools(mcp);
  await mcp.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(HTTP_PORT, "127.0.0.1", () => {
  log(`MCP HTTP server  listening on http://127.0.0.1:${HTTP_PORT}/mcp`);
  log(`Ready — waiting for Foundry VTT bridge and MCP clients.`);
});
