/**
 * Where the bridge token comes from.
 *
 * Extracted from bridge.js's hello frame so the precedence rule can be
 * unit-tested under Node (bridge.js touches `game`/`Hooks` at module scope and
 * can't be imported outside the browser). Pure: the caller reads both sources
 * and passes them in.
 *
 * Two sources, because they solve different problems:
 *
 *   world setting  – the GM sets it once in Module Settings and Foundry hands
 *                    it to every client that loads the world. No devtools, no
 *                    per-device step. This is the path normal users take.
 *   localStorage   – per-browser, set by hand. Predates the setting; kept as a
 *                    fallback so existing installs keep working, and as an
 *                    escape hatch for a client that must use a different token
 *                    than its world advertises.
 *
 * The world setting WINS when both are present. That's deliberate: it's the
 * only source a GM can fix for everyone at once, so a stale hand-set
 * localStorage value must not be able to keep a client locked out.
 */

/**
 * @param {{worldSetting?: string, localValue?: string}} [sources]
 * @returns {string} the token to send in the hello frame, or "" to send none
 */
export function resolveBridgeToken({ worldSetting = "", localValue = "" } = {}) {
  const fromWorld = String(worldSetting ?? "").trim();
  if (fromWorld) return fromWorld;
  return String(localValue ?? "").trim();
}
