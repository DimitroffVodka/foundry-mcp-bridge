/**
 * Foundry bridge management.
 *
 * Owns:
 *   - the `bridges` Map (userId → bridge metadata + socket)
 *   - hello-handshake handling
 *   - `routeBridge(targetUser)` resolution
 *   - `reconnectWaiters` — promises that resolve when a specific user's bridge
 *     announces itself via hello (used by `reload_foundry`)
 *
 * Each bridge identifies itself with a `{ type: "hello", userId, userName,
 * isGM }` frame on connect. Server tracks bridges by userId so MCP tool calls
 * can route to a specific Foundry user via the optional `targetUser` param.
 *
 * Backward compat: bridges that don't send a hello within HELLO_DEADLINE_MS
 * are registered under the `__legacy__` key as a default GM. Lets old bridge
 * installs keep working until they're upgraded.
 */
import { WebSocketServer } from "ws";
import { WS_PORT, HELLO_DEADLINE_MS, BRIDGE_TOKEN } from "./config.js";
import { log }                        from "./log.js";
import { pendingRequests }            from "./foundry-rpc.js";

export const bridges          = new Map();   // userId → { socket, userId, userName, isGM, connectedAt }
export const reconnectWaiters = new Map();   // userId → { resolve, reject, timer }
const pendingHello            = new WeakMap();// socket → setTimeout id

/**
 * Resolve `targetUser` to a connected bridge.
 *
 * @param {string|undefined} targetUser
 *   - undefined / "GM" / "self" → first GM bridge (single-GM constraint)
 *   - "<userName>"              → bridge whose userName matches exactly
 *   - "<userName>@<host>"       → disambiguator when two bridges share a name
 *                                 (matches the `host` reported in the hello
 *                                 frame, e.g. "Gamemaster@foundry.example.com")
 *   - "<userId>"                → bridge whose userId matches exactly
 * @returns {{socket: WebSocket, userId: string, userName: string, isGM: boolean, host: string, connectedAt: number}}
 * @throws if no matching bridge is connected
 */
export function routeBridge(targetUser) {
  if (!targetUser || targetUser === "GM" || targetUser === "self") {
    // Prefer a real (hello-identified) GM over the legacy fallback bucket
    // — otherwise a transient `__legacy__` entry that registered first
    // could win the default route even when a real GM is also connected.
    for (const b of bridges.values()) {
      if (b.isGM && b.userId !== "__legacy__") return b;
    }
    const legacy = bridges.get("__legacy__");
    if (legacy?.isGM) return legacy;
    throw new Error("No GM bridge connected.");
  }
  // 1. Exact userName match (back-compat, most common).
  // 2. "userName@host" disambiguator.
  // 3. Exact userId match (unambiguous escape hatch).
  for (const b of bridges.values()) {
    if (b.userId === "__legacy__") continue;
    if (b.userName === targetUser) return b;
    if (b.host && `${b.userName}@${b.host}` === targetUser) return b;
    if (b.userId === targetUser) return b;
  }
  const known = [...bridges.values()]
    .filter(b => b.userId !== "__legacy__")
    .map(b => b.host ? `${b.userName}@${b.host}` : b.userName)
    .join(", ");
  const hasLegacy = bridges.has("__legacy__");
  const suffix = hasLegacy
    ? " (a legacy bridge is also connected — upgrade the bridge module to address it by name)"
    : "";
  throw new Error(
    `No bridge connected for "${targetUser}". Connected: ${known || "(none)"}.${suffix}`
  );
}

/**
 * Start the WebSocket server that Foundry bridges connect to. Call once
 * from `server.js` startup. Returns the WebSocketServer instance for tests
 * or graceful shutdown handlers.
 */
export function startBridgeServer() {
  const wss = new WebSocketServer({ port: WS_PORT });

  wss.on("connection", (socket) => {
    log("Foundry bridge socket opened (awaiting hello)");

    // Schedule a deadline for the `hello` frame. If it doesn't arrive, the
    // bridge is from a pre-multi-user version — register as legacy GM so it
    // still works (only when no BRIDGE_TOKEN is set; otherwise legacy
    // fallback bypasses auth so we close the socket instead).
    const helloTimer = setTimeout(() => {
      pendingHello.delete(socket);
      if (BRIDGE_TOKEN) {
        log("Bridge missed hello and BRIDGE_TOKEN is set — closing socket");
        socket.close(1008, "auth required");
        return;
      }
      bridges.set("__legacy__", {
        socket,
        userId:      "__legacy__",
        userName:    "Unknown (legacy)",
        isGM:        true,
        connectedAt: Date.now(),
      });
      log("Bridge legacy-registered (no hello within 500ms) — treating as GM");
    }, HELLO_DEADLINE_MS);
    pendingHello.set(socket, helloTimer);

    socket.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      // Identity handshake — register the bridge keyed by userId.
      if (msg.type === "hello") {
        const t = pendingHello.get(socket);
        if (t) { clearTimeout(t); pendingHello.delete(socket); }

        if (BRIDGE_TOKEN && msg.token !== BRIDGE_TOKEN) {
          log(`Bridge hello rejected: invalid or missing token`);
          socket.close(1008, "auth failed");
          return;
        }

        const { userId, userName, isGM, host } = msg;
        if (!userId || !userName) {
          log(`Bridge sent malformed hello, ignoring: ${JSON.stringify(msg)}`);
          return;
        }

        // If this socket was already legacy-registered because hello arrived
        // after the deadline, evict the legacy entry — the real identity
        // supersedes it. (Fixes the "legacyBridgeConnected: true" cosmetic
        // bug where the stale entry stuck around after the real hello.)
        const legacy = bridges.get("__legacy__");
        if (legacy && legacy.socket === socket) {
          bridges.delete("__legacy__");
          log("Bridge promoted from legacy → identified");
        }

        const bridge = {
          socket,
          userId,
          userName,
          isGM: !!isGM,
          host: host || "",
          connectedAt: Date.now(),
        };
        bridges.set(userId, bridge);
        const hostStr = host ? ` @ ${host}` : "";
        log(`Bridge registered: ${userName}${hostStr} (${userId}) [${isGM ? "GM" : "player"}]`);

        // If reload_foundry (or anyone else) is waiting for this user to
        // (re)connect, resolve their promise.
        const waiter = reconnectWaiters.get(userId);
        if (waiter) {
          reconnectWaiters.delete(userId);
          clearTimeout(waiter.timer);
          waiter.resolve(bridge);
        }
        return;
      }

      // Normal request reply — match by request id.
      const pending = pendingRequests.get(msg.id);
      if (!pending) return;

      pendingRequests.delete(msg.id);
      clearTimeout(pending.timer);

      if (msg.error) pending.reject(new Error(msg.error));
      else           pending.resolve(msg.data);
    });

    socket.on("close", () => {
      // Clear any pending hello deadline.
      const t = pendingHello.get(socket);
      if (t) { clearTimeout(t); pendingHello.delete(socket); }

      // Find which bridges entry holds this socket and remove it.
      let removed = null;
      for (const [key, b] of bridges) {
        if (b.socket === socket) { removed = b; bridges.delete(key); break; }
      }
      if (removed) log(`Bridge closed: ${removed.userName}`);
      else         log("Unidentified bridge socket closed");

      // Reject pending requests waiting on this specific socket.
      for (const [id, pending] of pendingRequests) {
        if (pending.socket !== socket) continue;
        clearTimeout(pending.timer);
        pending.reject(new Error(
          `Bridge for "${removed?.userName ?? "unknown"}" disconnected`
        ));
        pendingRequests.delete(id);
      }
    });
  });

  log(`WebSocket bridge listening on ws://127.0.0.1:${WS_PORT}`);
  return wss;
}
