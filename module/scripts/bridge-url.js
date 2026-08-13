/**
 * Which address reaches the MCP server?
 *
 * Extracted from bridge.js's `connect()` so the branch can be unit-tested under
 * Node without a Foundry client (bridge.js itself touches `game`/`Hooks` at
 * module scope and can't be imported outside the browser). Pure: the caller
 * reads the setting and passes it in, along with the page hostname.
 *
 * The MCP server runs on exactly one machine, and which hostname reaches it
 * depends on where the browser sits relative to that machine — which is why
 * this can't be a constant:
 *
 *   Foundry at localhost:30000     → server is on this same box   → localhost
 *   Foundry at 192.168.0.106:30000 → server is on the Foundry box → that LAN IP
 *   Foundry at a public domain     → server is on the VIEWER's box → localhost
 *
 * The third case is why we don't simply mirror location.hostname everywhere: a
 * hosted Foundry (Forge, a VPS, a tunnel) is not running the MCP server — the
 * person sitting at the browser is. So the derived default follows the page
 * host only when that host is itself loopback or a private LAN address, and
 * falls back to localhost for public origins.
 */

/** Port the MCP server's WebSocket bridge listens on (server FOUNDRY_WS_PORT). */
export const DEFAULT_BRIDGE_PORT = 3001;

/** Hosts where the Foundry box could plausibly also be the MCP box. */
export function isLocalNetworkHost(hostname) {
  const h = String(hostname ?? "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return false;
  if (h === "localhost" || h.endsWith(".localhost") || h === "::1") return true;
  if (h.endsWith(".local") || h.endsWith(".lan") || h.endsWith(".internal")) return true;
  if (/^127\./.test(h)) return true;                         // loopback
  if (/^10\./.test(h)) return true;                          // RFC1918
  if (/^192\.168\./.test(h)) return true;                    // RFC1918
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;     // RFC1918
  if (/^169\.254\./.test(h)) return true;                    // link-local
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;             // IPv6 ULA
  if (/^fe80:/.test(h)) return true;                         // IPv6 link-local
  return false;
}

/**
 * Accept what someone is actually likely to type — "192.168.0.106",
 * "192.168.0.106:3001", "ws://host:3001" — and return a canonical
 * "ws://host:port".
 *
 * @returns {string} "" when the value is blank or unparseable, so the caller
 *   falls back to the derived default instead of handing garbage to WebSocket.
 */
export function normalizeBridgeUrl(value) {
  let raw = String(value ?? "").trim();
  if (!raw) return "";
  if (!/^wss?:\/\//i.test(raw)) raw = `ws://${raw}`;
  let url;
  try { url = new URL(raw); } catch { return ""; }
  if (!url.hostname) return "";
  if (!url.port) url.port = String(DEFAULT_BRIDGE_PORT);
  return `${url.protocol}//${url.host}`;
}

/**
 * The bridge URL a client should dial.
 *
 * @param {{configured?: string, hostname?: string}} [input]
 *   - configured: the `bridgeUrl` client setting ("" = auto)
 *   - hostname:   window.location.hostname
 * @returns {string} a "ws://host:port" URL — always usable, never blank
 */
export function resolveBridgeUrl({ configured = "", hostname = "" } = {}) {
  const override = normalizeBridgeUrl(configured);
  if (override) return override;

  const host = hostname || "localhost";
  const target = isLocalNetworkHost(host) ? host : "localhost";
  return `ws://${target}:${DEFAULT_BRIDGE_PORT}`;
}
