/**
 * Foundry RPC — the core request/response plumbing for tool handlers
 * proxying through the bridge.
 *
 * Owns:
 *   - `pendingRequests` Map (requestId → {resolve, reject, timer, socket})
 *   - `requestFoundry`     — low-level WS request, returns a Promise of raw data
 *   - `callFoundry`        — wraps `requestFoundry` for text-content tool replies
 *   - `callFoundryImage`   — wraps `requestFoundry` for image-content tool replies
 *
 * NOTE on cross-module cycle: `bridges.js` imports `pendingRequests` from
 * here (to drain on socket close), and we import `routeBridge` from there.
 * ESM handles this fine because both sides only access the imports at
 * function-call time, never during module evaluation.
 */
import { randomUUID } from "crypto";
import { REQUEST_TIMEOUT } from "./config.js";
import { routeBridge }     from "./bridges.js";
import { relayAvailable, relayClients, resolveRelayTarget, getRelayGateway } from "./relay-runtime.js";

export const pendingRequests = new Map();

/**
 * Send a JSON-RPC-shaped request to a Foundry bridge and return a Promise
 * that resolves with the bridge's `data` payload (or rejects on error /
 * timeout / disconnect).
 *
 * `timeoutMs` overrides the default REQUEST_TIMEOUT for this call only.
 * Used by tools that legitimately need to wait longer (e.g. `request_roll`
 * waiting for a player to click the dialog button).
 */
export async function requestFoundry(tool, params = {}, targetUser, timeoutMs = REQUEST_TIMEOUT) {
  // Relay first when the target names a client that is only reachable through
  // Foundry. A remote device can never hold a direct bridge socket — an https
  // page cannot open ws:// to a private IP, and `localhost` on that device
  // means that device — so the direct registry will never contain it. Checking
  // the direct path first would make the miss a dead end instead of a fallback.
  if (relayAvailable()) {
    const target = resolveRelayTarget(await relayClients(), targetUser);
    if (target) return getRelayGateway().request(target.clientId, tool, params, timeoutMs);
  }
  return requestOverDirectBridge(tool, params, targetUser, timeoutMs);
}

function requestOverDirectBridge(tool, params, targetUser, timeoutMs) {
  return new Promise((resolve, reject) => {
    let bridge;
    try { bridge = routeBridge(targetUser); }
    catch (err) { return reject(err); }

    if (!bridge.socket || bridge.socket.readyState !== 1) {
      return reject(new Error(`Bridge for "${bridge.userName}" is not open.`));
    }

    const id    = randomUUID();
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Request to Foundry timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    pendingRequests.set(id, { resolve, reject, timer, socket: bridge.socket });
    bridge.socket.send(JSON.stringify({ id, tool, params }));
  });
}

/**
 * Standard text-content wrapper. Pretty-JSON the result if it isn't already
 * a string. Most tool handlers use this. `timeoutMs` passes through.
 */
export async function callFoundry(tool, params = {}, targetUser, timeoutMs) {
  const data = await requestFoundry(tool, params, targetUser, timeoutMs);
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }] };
}

/**
 * Image-content wrapper. The bridge returns `{image, mimeType, width,
 * height, ...}`; we pack the image into an MCP image content block plus a
 * caption text block. The `caption` callback gets the full reply data.
 */
export async function callFoundryImage(tool, params, caption, targetUser) {
  const data = await requestFoundry(tool, params, targetUser);
  if (data?.error) return { content: [{ type: "text", text: `Error: ${data.error}` }] };
  return {
    content: [
      { type: "image", data: data.image, mimeType: data.mimeType },
      { type: "text",  text: caption(data) },
    ],
  };
}
