/**
 * proxy.mjs
 *
 * Bridges Claude Desktop's stdio transport to the shared HTTP MCP server.
 * Claude Desktop spawns this script; it forwards all tool calls to the
 * running HTTP server (started via start.bat).
 *
 * Claude Desktop config:
 *   "foundry-vtt": { "command": "node", "args": ["<path-to-repo>/server/proxy.mjs"] }
 */

import { Client }                          from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport }   from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server }                          from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport }            from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema,
         ListToolsRequestSchema }          from "@modelcontextprotocol/sdk/types.js";

const HTTP_URL = process.env.FOUNDRY_MCP_URL ?? "http://127.0.0.1:3000/mcp";

async function main() {
  // ── Connect to the HTTP server as a client ────────────────────────────────
  const client = new Client(
    { name: "foundry-proxy", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(HTTP_URL)));
  } catch (err) {
    process.stderr.write(
      `[foundry-proxy] Cannot reach HTTP server at ${HTTP_URL}\n` +
      `[foundry-proxy] Start it first by running server/start.bat (or "npm start" in the server folder)\n`
    );
    process.exit(1);
  }

  process.stderr.write(`[foundry-proxy] Connected to ${HTTP_URL}\n`);

  // ── Discover tools from the upstream server ───────────────────────────────
  const { tools } = await client.listTools();
  process.stderr.write(`[foundry-proxy] Proxying ${tools.length} tools\n`);

  // ── Local stdio server that forwards every call upstream ──────────────────
  const server = new Server(
    { name: "foundry-vtt", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    return await client.callTool({
      name:      request.params.name,
      arguments: request.params.arguments ?? {}
    });
  });

  const stdioTransport = new StdioServerTransport();
  await server.connect(stdioTransport);
  process.stderr.write(`[foundry-proxy] Ready (stdio)\n`);
}

main().catch((err) => {
  process.stderr.write(`[foundry-proxy] Fatal: ${err.message}\n`);
  process.exit(1);
});
