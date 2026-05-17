/**
 * Centralized config — env-var-driven ports + tunable timeouts/deadlines.
 * Imported by both bridge management and MCP transport layers.
 */
export const WS_PORT          = parseInt(process.env.FOUNDRY_WS_PORT  ?? "3001", 10);
export const HTTP_PORT        = parseInt(process.env.FOUNDRY_MCP_PORT ?? "3000", 10);
export const REQUEST_TIMEOUT  = 15_000;
export const HELLO_DEADLINE_MS = 500;
export const SNAPSHOT_TTL_MS   = 30 * 60 * 1000;  // 30 min
export const SNAPSHOT_MAX_LRU  = 50;
