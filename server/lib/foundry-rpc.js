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

export const pendingRequests = new Map();

/**
 * Send a JSON-RPC-shaped request to a Foundry bridge and return a Promise
 * that resolves with the bridge's `data` payload (or rejects on error /
 * timeout / disconnect).
 */
export function requestFoundry(tool, params = {}, targetUser) {
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
      reject(new Error(`Request to Foundry timed out after ${REQUEST_TIMEOUT / 1000}s`));
    }, REQUEST_TIMEOUT);

    pendingRequests.set(id, { resolve, reject, timer, socket: bridge.socket });
    bridge.socket.send(JSON.stringify({ id, tool, params }));
  });
}

/**
 * Standard text-content wrapper. Pretty-JSON the result if it isn't already
 * a string. Most tool handlers use this.
 */
export async function callFoundry(tool, params = {}, targetUser) {
  const data = await requestFoundry(tool, params, targetUser);
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
