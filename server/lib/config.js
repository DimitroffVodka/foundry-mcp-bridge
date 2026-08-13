/**
 * Centralized config — env-var-driven ports + tunable timeouts/deadlines.
 * Imported by both bridge management and MCP transport layers.
 */
import { readFileSync } from "node:fs";

// Server version — single source of truth is server/package.json, so a
// `git pull` that bumps the package version is automatically reflected here
// (and announced to the Foundry module in the hello-ack).
let _serverVersion = "0.0.0";
try {
  _serverVersion = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8")
  ).version || _serverVersion;
} catch { /* keep fallback */ }
export const SERVER_VERSION = _serverVersion;

// Wire-protocol version. Bump ONLY when the module↔server contract changes in
// a breaking way (new required handshake field, renamed tool semantics, etc.)
// — NOT on every release. The module compares this against its own and warns
// the user in the Foundry UI when the server is too old to talk to it.
export const PROTOCOL_VERSION = 1;

export const WS_PORT          = parseInt(process.env.FOUNDRY_WS_PORT  ?? "3001", 10);
export const WS_HOST          = process.env.FOUNDRY_WS_HOST ?? "127.0.0.1";
export const HTTP_PORT        = parseInt(process.env.FOUNDRY_MCP_PORT ?? "3000", 10);
export const REQUEST_TIMEOUT  = 15_000;
export const HELLO_DEADLINE_MS = 3000;
export const HEARTBEAT_INTERVAL_MS = 30_000;      // ping/pong interval to reap half-open bridge sockets
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
  // Run the recovery client headless. A headless client has no GPU, so the
  // relauncher also disables the Foundry canvas + CSS animations to avoid
  // software-WebGL (SwiftShader) pegging the CPU. See client-relauncher.js.
  headless: /^(1|true|yes)$/i.test(process.env.FOUNDRY_RELAUNCH_HEADLESS ?? ""),
  // Autonomous supervision: when set, the server watches for the configured GM
  // bridge dropping and re-launches the client automatically (with backoff).
  // Requires FOUNDRY_RELAUNCH_ENABLED=1 and a valid relaunch config.
  auto: /^(1|true|yes)$/i.test(process.env.FOUNDRY_RELAUNCH_AUTO ?? ""),
  autoIntervalMs: Number.parseInt(process.env.FOUNDRY_RELAUNCH_AUTO_INTERVAL_MS ?? "", 10) || 15_000,
  autoMaxBackoffMs: Number.parseInt(process.env.FOUNDRY_RELAUNCH_AUTO_MAX_BACKOFF_MS ?? "", 10) || 300_000,
};

// --- Relay gateway ---------------------------------------------------------
// A managed browser on this machine that joins Foundry as an ordinary client
// and relays tool calls to browsers the MCP server cannot reach directly —
// phones, tablets, a Steam Deck, anything on a hosted world. Off by default:
// it launches a real Chromium, so it should be an explicit choice.
export const RELAY_CONFIG = {
  enabled: /^(1|true|yes)$/i.test(process.env.FOUNDRY_RELAY_ENABLED ?? ""),
  foundryUrl: process.env.FOUNDRY_RELAY_URL ?? process.env.FOUNDRY_RELAUNCH_URL ?? "",
  // Must be GM-capable: publishing the gateway's public keys writes a world
  // setting, and Foundry only lets GMs do that. That restriction is what makes
  // the setting a trustworthy channel for the key in the first place.
  gmUser: process.env.FOUNDRY_RELAY_GM_USER ?? process.env.FOUNDRY_RELAUNCH_GM_USER ?? "",
  gmPassword: process.env.FOUNDRY_RELAY_GM_PASSWORD ?? process.env.FOUNDRY_RELAUNCH_GM_PASSWORD ?? "",
  chromePath: process.env.FOUNDRY_CHROME_PATH ?? "",
  userDataDir: process.env.FOUNDRY_RELAY_USER_DATA_DIR ?? "",
  headless: !/^(0|false|no)$/i.test(process.env.FOUNDRY_RELAY_HEADLESS ?? "1"),
};

// --- Security knobs (off by default; opt in via env vars) -----------------
// When BRIDGE_TOKEN is set, every MCP HTTP request must include the
// `Authorization: Bearer <token>` header, and every Foundry WebSocket hello
// frame must include a matching `token` field. When unset, the server
// trusts any localhost connection (current default behavior).
export const BRIDGE_TOKEN     = process.env.BRIDGE_TOKEN ?? "";

// Bridge-only secret. The two endpoints have very different exposure: the MCP
// HTTP server is hard-bound to 127.0.0.1 (server.js) and can never be reached
// off-box, while the WebSocket bridge is the half you deliberately open to the
// LAN when a second device has to connect (FOUNDRY_WS_HOST). Gating both on
// BRIDGE_TOKEN means you cannot secure the exposed half without also breaking
// every loopback MCP client that can't send an Authorization header — Codex
// has no per-server header config at all. FOUNDRY_WS_TOKEN gates only the
// WebSocket hello, and defaults to BRIDGE_TOKEN so existing single-token
// setups behave exactly as before.
export const WS_TOKEN         = process.env.FOUNDRY_WS_TOKEN ?? BRIDGE_TOKEN;

// True when the bridge port is reachable from somewhere other than this
// machine. Used to decide whether an unauthenticated bridge is a real hazard.
export const WS_HOST_IS_LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|localhost)$/i.test(WS_HOST);

// `evaluate` runs arbitrary JS in the live Foundry browser context. Gated
// behind an explicit opt-in to make the default install safer.
export const ALLOW_EVAL       = /^(1|true|yes)$/i.test(process.env.FOUNDRY_MCP_ALLOW_EVAL ?? "");

// World-authoring tools (create_folder, create_actor*, add_items_to_actor,
// create_journal_entry, update_journal_page) create persistent world data.
// Gated behind an explicit opt-in so the default install can't be tricked
// into mutating the world via an LLM hallucination.
export const ALLOW_WRITE      = /^(1|true|yes)$/i.test(process.env.FOUNDRY_MCP_ALLOW_WRITE ?? "");
export const ALLOW_SELF_TEST  = /^(1|true|yes)$/i.test(process.env.FOUNDRY_MCP_ALLOW_SELF_TEST ?? "");

// --- Tool-usage telemetry --------------------------------------------------
// Records every MCP tool invocation (name, ok/error, duration, args digest)
// into an in-memory aggregate (served at GET /api/usage) and a JSONL append
// log on disk — answering which tools actually earn their keep. ON by default;
// set FOUNDRY_MCP_USAGE=0 (or false/no/off) to disable, or
// FOUNDRY_MCP_USAGE_LOG=<path> to redirect the JSONL file. The log can hold
// truncated `evaluate` bodies and arg previews, so keep it local.
export const USAGE_TELEMETRY = {
  enabled: !/^(0|false|no|off)$/i.test(process.env.FOUNDRY_MCP_USAGE ?? ""),
  logPath: process.env.FOUNDRY_MCP_USAGE_LOG ?? "",  // "" → telemetry module's default path
  maxArgsChars: 1000,
  maxEvalBodyChars: 2000,
};
