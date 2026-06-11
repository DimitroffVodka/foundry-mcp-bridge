/**
 * Centralized config — env-var-driven ports + tunable timeouts/deadlines.
 * Imported by both bridge management and MCP transport layers.
 */
export const WS_PORT          = parseInt(process.env.FOUNDRY_WS_PORT  ?? "3001", 10);
export const WS_HOST          = process.env.FOUNDRY_WS_HOST ?? "127.0.0.1";
export const HTTP_PORT        = parseInt(process.env.FOUNDRY_MCP_PORT ?? "3000", 10);
export const REQUEST_TIMEOUT  = 15_000;
export const HELLO_DEADLINE_MS = 3000;
export const SNAPSHOT_TTL_MS   = 30 * 60 * 1000;  // 30 min
export const SNAPSHOT_MAX_LRU  = 50;
export const FOUNDRY_URLS      = (process.env.FOUNDRY_URLS ?? "")
  .split(",")
  .map(value => value.trim())
  .filter(Boolean);
export const RELAUNCH_CONFIG   = {
  enabled: /^(1|true|yes)$/i.test(process.env.FOUNDRY_RELAUNCH_ENABLED ?? ""),
  foundryUrl: process.env.FOUNDRY_RELAUNCH_URL ?? "",
  gmUser: process.env.FOUNDRY_RELAUNCH_GM_USER ?? "",
  gmPassword: process.env.FOUNDRY_RELAUNCH_GM_PASSWORD ?? "",
  chromePath: process.env.FOUNDRY_CHROME_PATH ?? "",
  userDataDir: process.env.FOUNDRY_CHROME_USER_DATA_DIR ?? "",
  allowRemote: /^(1|true|yes)$/i.test(
    process.env.FOUNDRY_RELAUNCH_ALLOW_REMOTE ?? ""
  ),
};

// --- Security knobs (off by default; opt in via env vars) -----------------
// When BRIDGE_TOKEN is set, every MCP HTTP request must include the
// `Authorization: Bearer <token>` header, and every Foundry WebSocket hello
// frame must include a matching `token` field. When unset, the server
// trusts any localhost connection (current default behavior).
export const BRIDGE_TOKEN     = process.env.BRIDGE_TOKEN ?? "";

// `evaluate` runs arbitrary JS in the live Foundry browser context. Gated
// behind an explicit opt-in to make the default install safer.
export const ALLOW_EVAL       = /^(1|true|yes)$/i.test(process.env.FOUNDRY_MCP_ALLOW_EVAL ?? "");

// World-authoring tools (create_folder, create_actor*, add_items_to_actor,
// create_journal_entry, update_journal_page) create persistent world data.
// Gated behind an explicit opt-in so the default install can't be tricked
// into mutating the world via an LLM hallucination.
export const ALLOW_WRITE      = /^(1|true|yes)$/i.test(process.env.FOUNDRY_MCP_ALLOW_WRITE ?? "");
export const ALLOW_SELF_TEST  = /^(1|true|yes)$/i.test(process.env.FOUNDRY_MCP_ALLOW_SELF_TEST ?? "");
