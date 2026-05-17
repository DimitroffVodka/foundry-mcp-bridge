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

// --- Security knobs (off by default; opt in via env vars) -----------------
// When BRIDGE_TOKEN is set, every MCP HTTP request must include the
// `Authorization: Bearer <token>` header, and every Foundry WebSocket hello
// frame must include a matching `token` field. When unset, the server
// trusts any localhost connection (current default behavior).
export const BRIDGE_TOKEN     = process.env.BRIDGE_TOKEN ?? "";

// `evaluate` runs arbitrary JS in the live Foundry browser context. Gated
// behind an explicit opt-in to make the default install safer.
export const ALLOW_EVAL       = /^(1|true|yes)$/i.test(process.env.FOUNDRY_MCP_ALLOW_EVAL ?? "");
