/**
 * Single shared logger. Writes to stderr so it doesn't interfere with stdout
 * MCP message framing on stdio transports.
 */
export function log(msg) {
  process.stderr.write(`[foundry-mcp] ${msg}\n`);
}
