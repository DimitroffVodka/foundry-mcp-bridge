/**
 * Foundry MCP Live — Client Module
 *
 * Runs inside Foundry VTT (browser context). Connects via WebSocket to the
 * local MCP server and responds to tool requests with live game state data.
 *
 * The MCP server (Node.js) is the WebSocket *server* — this module is the *client*.
 * This means the MCP server must be running before Foundry connects.
 */

const MODULE_ID = "foundry-mcp-live";
const WS_URL = "ws://localhost:3001";
const RECONNECT_DELAY = 5000;
const MAX_ERRORS = 1000;

// ---------------------------------------------------------------------------
// v14 body-class normalization
//
// Foundry v14 derives `document.body`'s page class from `location.pathname +
// location.search`. The `reload_foundry` MCP tool reloads with a cache-bust
// query string (`?_mcpReload=<timestamp>`), which produces a malformed class
// like `game?_mcpReload=1778810148980`. CSS selectors targeting `body.game`
// then fail and core UI elements (hotbar, sidebar, etc.) lose their layout.
//
// Fix: as early as possible, replace any `game?...` class with the plain
// `game` class. Done both immediately (in case body already exists) and on
// DOMContentLoaded (covers the race where body isn't built yet).
// ---------------------------------------------------------------------------
const _normalizeBodyClass = () => {
	const body = document.body;
	if (!body?.classList) return;
	const bad = [...body.classList].find(c => c.startsWith("game?"));
	if (bad) {
		body.classList.remove(bad);
		body.classList.add("game");
	}
};
_normalizeBodyClass();
document.addEventListener("DOMContentLoaded", _normalizeBodyClass, { once: true });

// ---------------------------------------------------------------------------
// Console error capture — rolling buffer
// ---------------------------------------------------------------------------
const errorBuffer = [];
const _origError = console.error;
const _origWarn = console.warn;

// Safely stringify an arbitrary console arg. Foundry passes circular doc
// references and prototype-rich objects through console.error/warn; a naive
// JSON.stringify throws on cycles and propagates the throw out of the wrapper,
// which would silently break normal logging. Reuse safeSerializeHookArg (defined
// later in this file — function declarations hoist) for depth-limited,
// cycle-safe serialization, with a string fallback if anything still throws.
const _safeStringifyConsoleArg = (a) => {
  if (a === null || typeof a !== "object") return String(a);
  try { return JSON.stringify(safeSerializeHookArg(a), null, 2); }
  catch { try { return String(a); } catch { return "[unserializable]"; } }
};

console.error = (...args) => {
  _origError.apply(console, args);
  errorBuffer.push({
    level: "error",
    message: args.map(_safeStringifyConsoleArg).join(" "),
    timestamp: Date.now()
  });
  if (errorBuffer.length > MAX_ERRORS) errorBuffer.shift();
};

console.warn = (...args) => {
  _origWarn.apply(console, args);
  errorBuffer.push({
    level: "warn",
    message: args.map(_safeStringifyConsoleArg).join(" "),
    timestamp: Date.now()
  });
  if (errorBuffer.length > MAX_ERRORS) errorBuffer.shift();
};

// ---------------------------------------------------------------------------
// Rigged dice — force specific face values for any dice rolled inside `fn`.
// `rig` is an array of face values consumed in order. Two delivery paths:
//   1. Patch Die.prototype._roll so auto-fulfillment uses our values.
//   2. Watch the DOM for Foundry's roll-resolver dialog (Manual Rolls
//      setting) and auto-fill+submit it from the same queue.
// Both consumers pull from one shared queue, so the order is preserved
// regardless of which fulfillment path Foundry happens to take.
// Values are clamped to [1, faces]; values past the queue fall back to the
// real RNG / blank input.
// ---------------------------------------------------------------------------
async function withRiggedDice(rig, fn) {
  if (!Array.isArray(rig) || rig.length === 0) return await fn();

  const queue = rig.map(v => Math.max(1, Math.round(v)));

  // -- Path 1: Die.prototype._roll patch ------------------------------------
  const DieClass = foundry?.dice?.terms?.Die || globalThis.Die;
  const proto    = DieClass?.prototype;
  const originalRoll = proto?._roll;
  if (proto && originalRoll) {
    proto._roll = function ({ minimize, maximize } = {}) {
      if (minimize) return 1;
      if (maximize) return this.faces;
      if (queue.length) return Math.min(queue.shift(), this.faces);
      return originalRoll.call(this, { minimize, maximize });
    };
  }

  // -- Path 2: roll-resolver dialog watcher ---------------------------------
  // When the user has Manual Rolls enabled, Foundry pops a roll-resolver
  // form per Roll. Each input is a number field with placeholder like "d6"
  // — we fill it from the queue and click Submit Rolls.
  const fillResolver = (form) => {
    if (!form || form.dataset.mcpFilled === "1") return;
    form.dataset.mcpFilled = "1";
    const inputs = form.querySelectorAll("input[type='number']");
    for (const inp of inputs) {
      const faces = parseInt((inp.placeholder || "").replace(/^d/i, ""), 10);
      const val = queue.length ? Math.min(queue.shift(), faces || 999) : 1;
      inp.value = String(val);
      inp.dispatchEvent(new Event("input",  { bubbles: true }));
      inp.dispatchEvent(new Event("change", { bubbles: true }));
    }
    // Submit on the next tick so any change handlers settle first
    setTimeout(() => form.querySelector("button[type='submit']")?.click(), 10);
  };

  // Catch any resolver already on screen at start (shouldn't happen, but safe)
  document.querySelectorAll("form.application.roll-resolver").forEach(fillResolver);

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches?.("form.application.roll-resolver")) fillResolver(node);
        node.querySelectorAll?.("form.application.roll-resolver").forEach(fillResolver);
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  try {
    return await fn();
  } finally {
    if (proto && originalRoll) proto._roll = originalRoll;
    observer.disconnect();
  }
}

// Summarise a Roll instance into a compact MCP-friendly shape.
function summariseRoll(r) {
  return {
    formula: r.formula,
    total:   r.total,
    result:  r.result,
    dice:    (r.dice ?? []).map(d => ({
      faces:   d.faces,
      results: (d.results ?? []).map(x => ({ result: x.result, active: x.active, discarded: !!x.discarded }))
    }))
  };
}

// Summarise a ChatMessage document for MCP. Captures stored rolls with the
// dice breakdown so callers can verify what actually rolled.
function summariseChatMessage(m) {
  if (!m) return null;
  const obj = m.toObject();
  const rolls = (obj.rolls || []).map(entry => {
    try {
      const parsed = typeof entry === "string" ? JSON.parse(entry) : entry;
      const dice = [];
      const collect = (terms) => {
        for (const t of terms ?? []) {
          if (t.class === "Die" || (typeof t.faces === "number" && Array.isArray(t.results))) {
            dice.push({
              faces: t.faces,
              results: (t.results || []).map(x => ({ result: x.result, active: x.active, discarded: !!x.discarded }))
            });
          }
          if (Array.isArray(t.terms)) collect(t.terms);
          if (Array.isArray(t.rolls)) for (const sub of t.rolls) collect(sub.terms);
        }
      };
      collect(parsed.terms);
      return { formula: parsed.formula, total: parsed.total, dice };
    } catch {
      return { error: "unparseable roll", raw: String(entry).slice(0, 200) };
    }
  });
  return { id: m.id, speaker: obj.speaker, flavor: obj.flavor, content: obj.content, rolls };
}

// Run `fn` while capturing any ChatMessage created (plus any dice rigging).
// The rig stays active during the post-fn wait too, so async action handlers
// (e.g. sheet button clicks that pop a roll-resolver dialog after returning)
// still get their dice filled from the queue.
async function runWithCapture({ rig, waitMs = 250 }, fn) {
  const createdIds = [];
  const hookId = Hooks.on("createChatMessage", (msg) => createdIds.push(msg.id));
  let result, error;
  try {
    result = await withRiggedDice(rig, async () => {
      const r = await fn();
      await new Promise(res => setTimeout(res, waitMs));
      return r;
    });
  } catch (err) {
    error = err;
  }
  Hooks.off("createChatMessage", hookId);
  if (error) throw error;
  const messages = createdIds.map(id => summariseChatMessage(game.messages.get(id))).filter(Boolean);
  return { result, messages };
}

// ---------------------------------------------------------------------------
// Safe serializer for hook arguments (documents, circular refs, deep trees)
// ---------------------------------------------------------------------------
function safeSerializeHookArg(val, depth = 0, maxDepth = 3) {
  if (val === null || val === undefined)    return val;
  const t = typeof val;
  if (t === "string" || t === "number" || t === "boolean") return val;
  if (t === "function") return `[Function ${val.name || "anon"}]`;
  if (depth >= maxDepth) return "[max depth]";

  // Foundry documents — summarise
  if (val?.documentName) {
    return {
      _document: val.documentName,
      id:   val.id   ?? null,
      name: val.name ?? null,
      uuid: val.uuid ?? null
    };
  }
  if (val instanceof Map) val = Object.fromEntries(val);
  if (val instanceof Set) val = Array.from(val);

  if (Array.isArray(val)) {
    return val.slice(0, 10).map(v => safeSerializeHookArg(v, depth + 1, maxDepth));
  }

  if (t === "object") {
    const out = {};
    const keys = Object.keys(val).slice(0, 25);
    for (const k of keys) {
      try { out[k] = safeSerializeHookArg(val[k], depth + 1, maxDepth); }
      catch { out[k] = "[unserializable]"; }
    }
    return out;
  }
  return String(val);
}

// Deep-diff two structures. Arrays whose elements all have `_id` are matched
// by id (so reordering doesn't show up as a change); otherwise positional.
/**
 * Project a structural path through an object/array/collection tree.
 * Used by the `snapshot_actors` handler. Walks the LIVE document
 * (not `actor.toObject()`) so derived data — `system.health.max` from
 * Active Effects, `prepareDerivedData` patches, getter-only properties
 * like `actor.statuses` — surfaces correctly. Test code almost always
 * wants the post-derivation effective value, not the persisted source.
 *
 * Tokens (left-to-right):
 *   - bare key            → property access, e.g. `system`
 *   - `[*]` or `[]`       → walk every element of an iterable, mapping rest
 *   - `[N]` (digits)      → access a specific array/collection index
 *
 * Iterable types accepted by `[*]`: Array, Collection (Foundry's Map
 * subclass for items/effects), Set, Map (yields [key, value] pairs).
 *
 * Examples (against a live Actor):
 *   projectPath(actor, "system.health.value")          → derived health value
 *   projectPath(actor, "effects[*].name")              → live effect names
 *   projectPath(actor, "items[*].system.quantity")     → derived item quantities
 *   projectPath(actor, "items[2].name")                → 3rd item's name
 *   projectPath(actor, "statuses")                     → Set of active status ids
 *
 * Returns `undefined` when any part of the path is missing — callers
 * compare projections directly so undefined naturally diffs against
 * present values without needing a try/catch.
 *
 * Note: when `[*]` hits a Set or Foundry Collection, the value is
 * spread to an array first via `[...node]`. Set yields its values;
 * Collection yields its documents (the Map values, not entries).
 */
function projectPath(obj, path) {
  // Tokenize: bare keys OR bracketed segments. Pattern matches one of:
  //   - `[*]` / `[]` (wildcard)
  //   - `[N]` (numeric index)
  //   - any run of non-`.[]` chars (key)
  const tokens = String(path).match(/\[[^\]]*\]|[^.\[\]]+/g) || [];
  return walk(obj, tokens);

  function walk(node, toks) {
    if (toks.length === 0) return serializeLeaf(node);
    if (node == null) return undefined;
    const head = toks[0];
    const rest = toks.slice(1);

    // Wildcard — fan out across any iterable.
    if (head === "[*]" || head === "[]") {
      const arr = toIterableArray(node);
      if (!arr) return undefined;
      return arr.map(item => walk(item, rest));
    }
    // Numeric index — pick one element.
    const idxMatch = head.match(/^\[(\d+)\]$/);
    if (idxMatch) {
      const i = parseInt(idxMatch[1], 10);
      const arr = toIterableArray(node);
      return walk(arr ? arr[i] : undefined, rest);
    }
    // Bare key — property access.
    return walk(node[head], rest);
  }

  // Convert Array / Collection / Set / Map to a plain array. Map yields
  // [k, v] pairs because spreading a Map produces entries; we accept that
  // edge case rather than guess at a key/value preference.
  function toIterableArray(node) {
    if (Array.isArray(node)) return node;
    if (node && typeof node[Symbol.iterator] === "function") {
      try { return [...node]; } catch { return null; }
    }
    return null;
  }

  // Convert a leaf value to JSON-friendly form. Foundry documents go
  // through `.toObject()`; Sets and other iterables get spread; plain
  // values pass through. The outer JSON.stringify in the tool result
  // handles primitive serialization.
  function serializeLeaf(node) {
    if (node == null) return node;
    if (typeof node?.toObject === "function") return node.toObject();
    if (node instanceof Set) return [...node];
    if (node instanceof Map) return [...node.entries()];
    return node;
  }
}

function deepDiff(a, b, path = "") {
  const changes = [];
  if (a === b) return changes;

  if (a === undefined) { changes.push({ path, op: "added",   after:  b }); return changes; }
  if (b === undefined) { changes.push({ path, op: "removed", before: a }); return changes; }

  const ta = typeof a, tb = typeof b;
  const isObjA = ta === "object" && a !== null;
  const isObjB = tb === "object" && b !== null;

  if (!isObjA || !isObjB || Array.isArray(a) !== Array.isArray(b)) {
    if (a !== b) changes.push({ path, op: "changed", before: a, after: b });
    return changes;
  }

  if (Array.isArray(a)) {
    const aHasIds = a.length > 0 && a.every(e => e && typeof e === "object" && "_id" in e);
    const bHasIds = b.length > 0 && b.every(e => e && typeof e === "object" && "_id" in e);
    if (aHasIds && bHasIds) {
      const aMap = new Map(a.map(e => [e._id, e]));
      const bMap = new Map(b.map(e => [e._id, e]));
      const ids = new Set([...aMap.keys(), ...bMap.keys()]);
      for (const id of ids) changes.push(...deepDiff(aMap.get(id), bMap.get(id), `${path}[#${id}]`));
      return changes;
    }
    const max = Math.max(a.length, b.length);
    for (let i = 0; i < max; i++) changes.push(...deepDiff(a[i], b[i], `${path}[${i}]`));
    return changes;
  }

  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) changes.push(...deepDiff(a[k], b[k], path ? `${path}.${k}` : k));
  return changes;
}

// Resolve a token reference (id, token name, or linked actor name) on a scene.
function _findToken(scene, ref) {
  if (!ref || !scene) return null;
  return scene.tokens.get(ref)
      ?? scene.tokens.find(t => t.name === ref)
      ?? scene.tokens.find(t => t.actor?.name === ref);
}

// ---------------------------------------------------------------------------
// A* grid pathfinder + door-aware collision wrapper, used by `move_token_pathed`.
// ---------------------------------------------------------------------------

// Test whether a multi-cell token can move between two pixel corners without
// any occupied subcell colliding. Origin/target are top-left pixel coords.
function _cellsBlocked(fx, fy, tx, ty, tokenW, tokenH, gridSize, collision) {
  for (let i = 0; i < tokenW; i++) {
    for (let j = 0; j < tokenH; j++) {
      const ox = fx + i * gridSize + gridSize / 2;
      const oy = fy + j * gridSize + gridSize / 2;
      const dx = tx + i * gridSize + gridSize / 2;
      const dy = ty + j * gridSize + gridSize / 2;
      if (collision.testCollision({ x: ox, y: oy }, { x: dx, y: dy }, { type: "move", mode: "any" })) return true;
    }
  }
  return false;
}

function _findGridPath({ startX, startY, endX, endY, gridSize, collision, tokenWidth = 1, tokenHeight = 1, maxNodes = 2500 }) {
  const DIRS = [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]];
  const cheb = (ax, ay, bx, by) => Math.max(Math.abs(ax - bx), Math.abs(ay - by));
  const key  = (gx, gy) => `${gx},${gy}`;

  const sGX = Math.floor(startX / gridSize);
  const sGY = Math.floor(startY / gridSize);
  const eGX = Math.floor(endX   / gridSize);
  const eGY = Math.floor(endY   / gridSize);
  if (sGX === eGX && sGY === eGY) return { path: [], cost: 0 };

  const open     = [{ gx: sGX, gy: sGY, g: 0, f: cheb(sGX, sGY, eGX, eGY) }];
  const gScore   = new Map([[key(sGX, sGY), 0]]);
  const cameFrom = new Map();
  const closed   = new Set();
  let explored   = 0;

  while (open.length > 0) {
    if (explored >= maxNodes) return null;
    let minIdx = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[minIdx].f) minIdx = i;
    const cur = open[minIdx];

    if (cur.gx === eGX && cur.gy === eGY) {
      const path = [];
      let k = key(eGX, eGY);
      while (cameFrom.has(k)) {
        const [gxs, gys] = k.split(",");
        path.push({ x: Number(gxs) * gridSize, y: Number(gys) * gridSize });
        k = cameFrom.get(k);
      }
      path.reverse();
      return { path, cost: cur.g };
    }

    open.splice(minIdx, 1);
    const curKey = key(cur.gx, cur.gy);
    closed.add(curKey);
    explored++;

    for (const [dx, dy] of DIRS) {
      const nx = cur.gx + dx;
      const ny = cur.gy + dy;
      const nk = key(nx, ny);
      if (closed.has(nk)) continue;
      if (_cellsBlocked(cur.gx * gridSize, cur.gy * gridSize, nx * gridSize, ny * gridSize, tokenWidth, tokenHeight, gridSize, collision)) continue;
      const tg = cur.g + 1;
      const existing = gScore.get(nk);
      if (existing !== undefined && tg >= existing) continue;
      cameFrom.set(nk, curKey);
      gScore.set(nk, tg);
      const f = tg + cheb(nx, ny, eGX, eGY);
      const eIdx = open.findIndex(n => n.gx === nx && n.gy === ny);
      if (eIdx >= 0) { open[eIdx].g = tg; open[eIdx].f = f; }
      else open.push({ gx: nx, gy: ny, g: tg, f });
    }
  }
  return null;
}

function _direction(a, b, c) { return (c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x); }
function _onSegment(p, q, r) {
  return r.x <= Math.max(p.x, q.x) && r.x >= Math.min(p.x, q.x) &&
         r.y <= Math.max(p.y, q.y) && r.y >= Math.min(p.y, q.y);
}
function _segmentsIntersect(p1, p2, p3, p4) {
  const d1 = _direction(p3, p4, p1), d2 = _direction(p3, p4, p2);
  const d3 = _direction(p1, p2, p3), d4 = _direction(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
         ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
function _segmentsIntersectRelaxed(p1, p2, p3, p4) {
  const d1 = _direction(p3, p4, p1), d2 = _direction(p3, p4, p2);
  const d3 = _direction(p1, p2, p3), d4 = _direction(p1, p2, p4);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
      ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  if (d1 === 0 && _onSegment(p3, p4, p1)) return true;
  if (d2 === 0 && _onSegment(p3, p4, p2)) return true;
  if (d3 === 0 && _onSegment(p1, p2, p3)) return true;
  if (d4 === 0 && _onSegment(p1, p2, p4)) return true;
  return false;
}
function _wallToSeg(w) {
  return [
    { x: w.c?.[0] ?? 0, y: w.c?.[1] ?? 0 },
    { x: w.c?.[2] ?? 0, y: w.c?.[3] ?? 0 }
  ];
}

// Collision checker that treats closed openable doors as passable so A* can
// route through them. Caller is responsible for actually opening doors when
// walking the returned path (see _findDoorsAlongPath).
function _createDoorAwareCollision(realCollision, walls) {
  const impassable = walls.filter(w => w.move !== 0 && w.door !== 1);
  return {
    testCollision(origin, destination, config) {
      const blocked = realCollision.testCollision(origin, destination, config);
      if (!blocked) return false;
      for (const w of impassable) {
        const [p3, p4] = _wallToSeg(w);
        if (_segmentsIntersect(origin, destination, p3, p4)) return true;
      }
      // blocked only by an openable door → treat as passable
      return false;
    }
  };
}

function _findDoorsAlongPath(path, startX, startY, gridSize, openableDoors) {
  const centers = [
    { x: startX + gridSize / 2, y: startY + gridSize / 2 },
    ...path.map(p => ({ x: p.x + gridSize / 2, y: p.y + gridSize / 2 }))
  ];
  const out = [];
  const seen = new Set();
  for (let i = 0; i < centers.length - 1; i++) {
    for (const door of openableDoors) {
      const id = door._id ?? door.id;
      if (seen.has(id)) continue;
      const [p3, p4] = _wallToSeg(door);
      if (_segmentsIntersectRelaxed(centers[i], centers[i + 1], p3, p4)) {
        out.push({ wallId: id, betweenIndex: i + 1 });
        seen.add(id);
      }
    }
  }
  return out;
}

const _DOOR_OPEN_DELAY = 400;
const _delay = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Grid overlay used by `capture_scene` — white grid lines + (gx,gy) labels.
// ---------------------------------------------------------------------------
function _addGridOverlay(canvasRef) {
  const P = globalThis.PIXI;
  if (!P) return null;
  const grid = canvasRef?.scene?.grid?.size;
  const dims = canvasRef?.scene?.dimensions;
  if (!grid || !dims) return null;

  const fontSize = Math.round(grid * 0.22);
  const padding  = Math.round(grid * 0.05);

  const overlay = new P.Container();
  overlay.name = "mcpGridOverlay";

  const sGX = Math.floor(dims.sceneX / grid);
  const sGY = Math.floor(dims.sceneY / grid);
  const eGX = Math.ceil((dims.sceneX + dims.sceneWidth)  / grid);
  const eGY = Math.ceil((dims.sceneY + dims.sceneHeight) / grid);

  const lines = new P.Graphics();
  lines.lineStyle(1, 0xFFFFFF, 0.15);
  for (let gx = sGX; gx <= eGX; gx++) {
    const x = gx * grid;
    lines.moveTo(x, dims.sceneY);
    lines.lineTo(x, dims.sceneY + dims.sceneHeight);
  }
  for (let gy = sGY; gy <= eGY; gy++) {
    const y = gy * grid;
    lines.moveTo(dims.sceneX, y);
    lines.lineTo(dims.sceneX + dims.sceneWidth, y);
  }
  overlay.addChild(lines);

  const style = new P.TextStyle({
    fontFamily: "Arial",
    fontSize,
    fill: 0xFFFFFF,
    stroke: 0x000000,
    strokeThickness: Math.max(2, Math.round(fontSize * 0.15)),
    letterSpacing: 0
  });
  for (let gx = sGX; gx < eGX; gx++) {
    for (let gy = sGY; gy < eGY; gy++) {
      const text = new P.Text(`${gx},${gy}`, style);
      text.x = gx * grid + padding;
      text.y = gy * grid + padding;
      text.alpha = 0.65;
      overlay.addChild(text);
    }
  }
  canvasRef.stage.addChild(overlay);
  return overlay;
}

function _removeGridOverlay(canvasRef, overlay) {
  if (!overlay) return;
  try {
    canvasRef.stage.removeChild(overlay);
    overlay.destroy({ children: true });
  } catch {}
}

// ---------------------------------------------------------------------------
// Shared helpers for world-authoring handlers
// ---------------------------------------------------------------------------

/**
 * Resolve an item descriptor (either { pack, documentId } from a compendium,
 * or an inline { name, type, system, ... } definition) into a creation-ready
 * data object suitable for Actor.create's `items` array or
 * `actor.createEmbeddedDocuments("Item", [...])`.
 *
 * Throws on invalid input — caller's dispatcher returns the message as the
 * tool error payload.
 */
async function _resolveItemRef(item) {
  if (item == null || typeof item !== "object") {
    throw new Error("Item descriptor must be an object");
  }
  if (item.pack && item.documentId) {
    const pack = game.packs.get(item.pack);
    if (!pack) throw new Error(`Pack "${item.pack}" not found`);
    const doc = await pack.getDocument(item.documentId);
    if (!doc) throw new Error(`Document "${item.documentId}" not found in pack "${item.pack}"`);
    const data = doc.toObject();
    if (item.nameOverride) data.name = item.nameOverride;
    return data;
  }
  if (!item.name || !item.type) {
    throw new Error("Inline item requires at least `name` and `type`");
  }
  return item;
}

/**
 * Resolve a folder reference (id wins, else exact-name match within type, else
 * auto-create when `autoCreate` is true). Returns the resolved folder id or
 * null when no reference was provided. Throws if a name was given but cannot
 * be found AND autoCreate is false.
 */
async function _resolveFolder(type, folderId, folderName, autoCreate = true) {
  if (folderId) {
    const existing = game.folders.get(folderId);
    if (!existing) throw new Error(`Folder "${folderId}" not found`);
    if (existing.type !== type) {
      throw new Error(`Folder "${folderId}" is type ${existing.type}, expected ${type}`);
    }
    return existing.id;
  }
  if (!folderName) return null;
  const existing = game.folders.find(f => f.type === type && f.name === folderName);
  if (existing) return existing.id;
  if (!autoCreate) throw new Error(`Folder "${folderName}" of type ${type} not found`);
  const created = await Folder.create({ name: folderName, type });
  return created.id;
}

// ---------------------------------------------------------------------------
// Per-system dispatchers for native roll APIs (v0.10.0)
// ---------------------------------------------------------------------------

/**
 * Dispatch table for system-specific roll logic. Each system implementation
 * maps generic concepts (rollSkill, rollAttack) to its own native methods.
 * v0.10.0 covers: dnd5e, pf2e, shadowdark, vagabond.
 */
const DISPATCHERS = {
  dnd5e: {
    // dnd5e v3+ signature: rollSkill(config, dialog, message)
    // Identifier goes INSIDE the config object, not as the first positional arg.
    rollSkill: (actor, { identifier, target, adv }) => {
      const config = { skill: identifier, target };
      if (adv === "advantage") config.advantage = true;
      if (adv === "disadvantage") config.disadvantage = true;
      return actor.rollSkill(config, { configure: false });
    },
    rollAbility: (actor, { identifier, target, adv }) => {
      const config = { ability: identifier, target };
      if (adv === "advantage") config.advantage = true;
      if (adv === "disadvantage") config.disadvantage = true;
      return actor.rollAbilityCheck(config, { configure: false });
    },
    rollSave: (actor, { identifier, target, adv }) => {
      const config = { ability: identifier, target };
      if (adv === "advantage") config.advantage = true;
      if (adv === "disadvantage") config.disadvantage = true;
      return actor.rollSavingThrow(config, { configure: false });
    },
    rollAttack: async (actor, item, { activityId, adv }) => {
      const activity = activityId ? item.system.activities.get(activityId) : item.system.activities.find(a => a.type === "attack");
      if (!activity) throw new Error(`No attack activity found on item "${item.id}"`);
      const config = {};
      if (adv === "advantage") config.advantage = true;
      if (adv === "disadvantage") config.disadvantage = true;
      return { roll: await activity.rollAttack(config, { configure: false }), activity };
    },
    // dnd5e v3+: damage activity inherits crit from `config.attack` (the prior
    // attack roll). When no attack roll is available (caller used
    // request_damage_roll standalone), pass `critical: true` as a force-flag.
    // `rollMode` was incorrect here — it controls visibility, not crit state.
    rollDamage: (activity, { isCritical, attackRoll }) => {
      const config = {};
      if (attackRoll) config.attack = attackRoll;
      if (isCritical && !attackRoll) config.critical = true;
      return activity.rollDamage(config, { configure: false });
    },
    applyDamage: (actor, { amount, type, multiplier = 1 }) => {
      return actor.applyDamage([{ value: amount, type }], { multiplier });
    }
  },

  pf2e: {
    rollSkill: (actor, { identifier, target }) => {
      const stat = actor.skills[identifier] || actor[identifier];
      if (!stat?.roll) throw new Error(`Skill/Statistic "${identifier}" not found on actor`);
      return stat.roll({ dc: target ? { value: target } : undefined, skipDialog: true });
    },
    rollAbility: (actor, { identifier, target }) => {
      const stat = actor.abilities[identifier];
      if (!stat?.roll) throw new Error(`Ability "${identifier}" not found on actor`);
      return stat.roll({ dc: target ? { value: target } : undefined, skipDialog: true });
    },
    rollSave: (actor, { identifier, target }) => {
      const stat = actor.saves[identifier];
      if (!stat?.roll) throw new Error(`Save "${identifier}" not found on actor`);
      return stat.roll({ dc: target ? { value: target } : undefined, skipDialog: true });
    },
    // Helper used by request_damage_roll to fetch a Strike without re-rolling
    // the attack (which would post a duplicate chat card).
    getStrike: (actor, itemId) => {
      const strike = actor.system.actions.find(a => a.item.id === itemId);
      if (!strike) throw new Error(`No Strike found for item "${itemId}"`);
      return strike;
    },
    rollAttack: async (actor, item) => {
      const strike = actor.system.actions.find(a => a.item.id === item.id);
      if (!strike) throw new Error(`No Strike found for item "${item.id}"`);
      return { roll: await strike.variants[0].roll({ skipDialog: true }), strike };
    },
    rollDamage: (strike, { isCritical }) => {
      return isCritical ? strike.critical({ skipDialog: true }) : strike.damage({ skipDialog: true });
    },
    applyDamage: (actor, { amount, type }) => {
      return actor.applyDamage({ damage: amount, rollOptions: type ? new Set([`damage:type:${type}`]) : new Set() });
    }
  },

  shadowdark: {
    rollSkill: (actor, { identifier, target, adv }) => {
      const config = { target, skipPrompt: true };
      if (adv === "advantage") config.advantage = 1;
      if (adv === "disadvantage") config.advantage = -1;
      return actor.system.rollStatCheck(identifier, config);
    },
    rollAbility: (actor, { identifier, target, adv }) => {
      const config = { target, skipPrompt: true };
      if (adv === "advantage") config.advantage = 1;
      if (adv === "disadvantage") config.advantage = -1;
      return actor.system.rollStatCheck(identifier, config);
    },
    rollSave: (actor, { identifier, target, adv }) => {
      const config = { target, skipPrompt: true };
      if (adv === "advantage") config.advantage = 1;
      if (adv === "disadvantage") config.advantage = -1;
      return actor.system.rollStatCheck(identifier, config);
    },
    // Shadowdark's actor.system.rollAttack ALWAYS shows a dialog and doesn't
    // return the rolled result programmatically — it just posts to chat. For
    // NPC Attacks the system also has no separate rollDamage. To support
    // programmatic attack/damage rolls we build the formulas directly from
    // the item data and evaluate them ourselves. Crit detection is based on
    // the d20 face matching the configured successThreshold.
    rollAttack: async (actor, item, { adv }) => {
      const isNpc = actor.type?.toLowerCase() === "npc";
      if (isNpc) {
        // NPC Attack item: build `1d20 + attackBonus` and roll directly.
        const attackBonus = item.system?.bonuses?.attackBonus ?? 0;
        const critSuccess = item.system?.bonuses?.critical?.successThreshold ?? 20;
        let d20 = "1d20";
        if (adv === "advantage")    d20 = "2d20kh1";
        if (adv === "disadvantage") d20 = "2d20kl1";
        const formula = `${d20} + ${attackBonus}`;
        const roll = await new Roll(formula).evaluate();
        // Stamp isCritical flag based on the natural d20 face.
        const d20Term = roll.dice[0];
        const natural = d20Term?.results?.find(r => r.active)?.result ?? d20Term?.total;
        roll.isCritical = natural >= critSuccess;
        await roll.toMessage({
          speaker: ChatMessage.getSpeaker({ actor }),
          flavor: `${item.name} (attack)`
        });
        return { roll, actor, item, isNpc: true };
      }
      // Player path — keep the dialog-driven system flow; programmatic returns
      // are limited and may need follow-up work for full coverage.
      const config = { skipPrompt: true };
      if (adv === "advantage") config.advantage = 1;
      if (adv === "disadvantage") config.advantage = -1;
      return { roll: await actor.system.rollAttack(item.uuid, config), actor, item, isNpc: false };
    },
    rollDamage: async (actor, ctx) => {
      const { item, isCritical } = ctx;
      const isNpc = (ctx.isNpc ?? actor?.type?.toLowerCase() === "npc");
      if (isNpc && item) {
        const damageFormula = item.system?.damage?.value ?? "0";
        const damageBonus   = item.system?.bonuses?.damageBonus ?? 0;
        const critMult      = item.system?.bonuses?.critical?.multiplier ?? 2;
        // Crit doubles the dice count (standard d20-system convention).
        const base = isCritical
          ? damageFormula.replace(/(\d+)d(\d+)/g, (_, n, faces) => `${parseInt(n, 10) * critMult}d${faces}`)
          : damageFormula;
        const formula = `${base}${damageBonus ? ` + ${damageBonus}` : ""}`;
        const roll = await new Roll(formula).evaluate();
        await roll.toMessage({
          speaker: ChatMessage.getSpeaker({ actor }),
          flavor: `${item.name} (damage${isCritical ? " — critical" : ""})`
        });
        return roll;
      }
      // Player-side falls back to the system's rollDamage if it exists.
      const itemUuid = ctx.itemUuid ?? item?.uuid;
      if (!actor?.system?.rollDamage) throw new Error("Shadowdark Player damage path unavailable — actor.system.rollDamage missing");
      return actor.system.rollDamage(itemUuid, { skipPrompt: true });
    },
    // Shadowdark's actor.applyDamage(amount, multiplier) may not return a
    // Promise that awaits the underlying actor.update, so hpAfter reads can
    // be stale. Compute the delta authoritatively from the captured before
    // value and the system's clamp formula, and await the explicit update
    // so the caller sees a fully-propagated HP value.
    applyDamage: async (actor, { amount, multiplier = 1 }) => {
      const before = actor.system.attributes?.hp?.value ?? 0;
      const max    = actor.system.attributes?.hp?.max   ?? before;
      const newValue = Math.max(0, Math.min(max, before - (amount * multiplier)));
      await actor.update({ "system.attributes.hp.value": newValue });
      return { delta: before - newValue, newHP: newValue };
    }
  },

  vagabond: {
    // NOTE: Vagabond's VagabondRollBuilder.buildAndEvaluateD20 signature does
    // not currently accept a stat/skill identifier through this entry point
    // (per research). The `identifier` param is captured for API symmetry but
    // ignored here — the underlying roll uses the actor's default stat
    // resolution. Extend this when a richer Vagabond entry point exists.
    rollSkill: (actor, { identifier }) => {
      return game.vagabond.api.VagabondRollBuilder.buildAndEvaluateD20(actor, 'none');
    },
    rollAbility: (actor, { identifier }) => {
      return game.vagabond.api.VagabondRollBuilder.buildAndEvaluateD20(actor, 'none');
    },
    rollSave: (actor, { identifier }) => {
      return game.vagabond.api.VagabondRollBuilder.buildAndEvaluateD20(actor, 'none');
    },
    rollAttack: async (actor, item) => {
      return { roll: await item.rollAttack(actor, 'none'), item, actor };
    },
    rollDamage: (item, { isCritical, actor }) => {
      return item.rollDamage(actor, isCritical);
    },
    applyDamage: async (actor, { amount }) => {
      const currentHP = actor.system.health.value;
      const newHP = Math.max(0, currentHP - amount);
      await actor.update({ 'system.health.value': newHP });
      if (game.vagabond.api.VagabondChatCard) {
        await game.vagabond.api.VagabondChatCard.applyResult(actor, {
          type: 'damage',
          rawAmount: amount,
          finalAmount: amount,
          previousValue: currentHP,
          newValue: newHP,
        });
      }
      return { delta: amount, newHP };
    }
  }
};

/**
 * Normalise a generic roll result into the canonical MCP shape.
 */
function _normalizeRollResult(systemId, rawRoll, actor, dc) {
  const roll = Array.isArray(rawRoll) ? rawRoll[0] : rawRoll;
  if (!roll) return null;

  const result = {
    system: systemId,
    total: roll.total,
    formula: roll.formula,
    rolledBy: actor.name,
    dice: (roll.dice ?? []).map(d => ({
      faces: d.faces,
      results: (d.results ?? []).map(r => r.result)
    }))
  };

  if (dc != null) {
    if (systemId === "pf2e") {
      result.success = roll.degreeOfSuccess >= 2;
    } else {
      result.success = roll.total >= dc;
    }
  }

  if (systemId === "pf2e") {
    result.degreeOfSuccess = roll.degreeOfSuccess;
  } else if (roll.isCritical !== undefined) {
    result.isCritical = roll.isCritical;
  } else if (roll.options?.critical) {
    result.isCritical = true;
  }

  return result;
}

/**
 * Normalise an attack roll into the canonical shape, computing 'hit'.
 */
function _normalizeAttackResult(systemId, rawRoll, targetAC) {
  const roll = Array.isArray(rawRoll) ? rawRoll[0] : rawRoll;
  if (!roll) return null;

  const result = {
    system: systemId,
    total: roll.total,
    formula: roll.formula,
    targetAC: targetAC
  };

  if (systemId === "pf2e") {
    result.degreeOfSuccess = roll.degreeOfSuccess;
    result.hit = roll.degreeOfSuccess >= 2;
  } else {
    result.isCritical = roll.isCritical || !!roll.options?.critical;
    result.hit = result.isCritical || (targetAC != null && roll.total >= targetAC);
  }

  return result;
}

/**
 * Normalise a damage roll, extracting per-type breakdown if available.
 */
function _normalizeDamageResult(systemId, rawRoll, isCritical) {
  const roll = Array.isArray(rawRoll) ? rawRoll[0] : rawRoll;
  if (!roll) return null;

  const types = [];
  // dnd5e: try to find types in terms
  if (systemId === "dnd5e" && Array.isArray(roll.terms)) {
    for (const term of roll.terms) {
      if (term.options?.flavor) {
        types.push({ amount: term.total, type: term.options.flavor });
      }
    }
  }
  // pf2e: try to find instances
  if (systemId === "pf2e" && Array.isArray(roll.instances)) {
    for (const inst of roll.instances) {
      types.push({ amount: inst.total, type: inst.type });
    }
  }

  if (types.length === 0) {
    types.push({ amount: roll.total, type: "total" });
  }

  return {
    total: roll.total,
    formula: roll.formula,
    isCritical: !!isCritical,
    types
  };
}

// ---------------------------------------------------------------------------
// Request handlers — each returns serialisable data
// ---------------------------------------------------------------------------
const handlers = {

  /** Basic system & world info */
  get_game_info: () => {
    return {
      system: {
        id: game.system.id,
        title: game.system.title,
        version: game.system.version
      },
      world: {
        id: game.world.id,
        title: game.world.title
      },
      foundryVersion: game.version,
      users: game.users.contents.map(u => ({
        name: u.name,
        role: u.role,
        active: u.active
      }))
    };
  },

  /** List all actors with summary info */
  list_actors: (params = {}) => {
    let actors = game.actors.contents;
    if (params.type) {
      actors = actors.filter(a => a.type === params.type);
    }
    if (params.folder) {
      actors = actors.filter(a => a.folder?.name === params.folder);
    }
    return actors.map(a => ({
      id: a.id,
      name: a.name,
      type: a.type,
      folder: a.folder?.name ?? null,
      img: a.img
    }));
  },

  /** Full actor data by id or name */
  get_actor: (params = {}) => {
    const actor = params.id
      ? game.actors.get(params.id)
      : game.actors.getName(params.name);
    if (!actor) return { error: `Actor not found: ${params.id || params.name}` };
    return actor.toObject();
  },

  /** Currently selected token's actor */
  get_selected_token: () => {
    const token = canvas.tokens?.controlled?.[0];
    if (!token) return { error: "No token selected" };
    return {
      token: {
        id: token.id,
        name: token.name,
        x: token.x,
        y: token.y,
        elevation: token.document.elevation
      },
      actor: token.actor?.toObject() ?? null
    };
  },

  /** List active modules with versions */
  list_modules: (params = {}) => {
    let mods = Array.from(game.modules.values());
    if (params.activeOnly !== false) {
      mods = mods.filter(m => m.active);
    }
    return mods.map(m => ({
      id: m.id,
      title: m.title,
      version: m.version,
      active: m.active
    }));
  },

  /** List compendium packs with metadata */
  list_compendiums: (params = {}) => {
    let packs = game.packs.contents;
    if (params.type) {
      packs = packs.filter(p => p.documentName === params.type);
    }
    return packs.map(p => ({
      id: p.collection,
      label: p.metadata.label,
      type: p.documentName,
      system: p.metadata.system ?? null,
      count: p.index.size
    }));
  },

  /** Search a compendium pack by text query */
  search_compendium: async (params = {}) => {
    const pack = game.packs.get(params.pack);
    if (!pack) return { error: `Pack not found: ${params.pack}` };

    // Ensure index is loaded
    if (!pack.index.size) await pack.getIndex();

    let results = Array.from(pack.index.values());

    if (params.query) {
      const q = params.query.toLowerCase();
      results = results.filter(e => e.name.toLowerCase().includes(q));
    }

    // Optionally load full documents
    if (params.full && results.length <= 20) {
      const docs = await pack.getDocuments({
        _id__in: results.map(r => r._id)
      });
      return docs.map(d => d.toObject());
    }

    return results.slice(0, 50).map(e => ({
      _id: e._id,
      name: e.name,
      type: e.type ?? null,
      img: e.img ?? null
    }));
  },

  /** Get a specific compendium document by pack + id or name */
  get_compendium_document: async (params = {}) => {
    const pack = game.packs.get(params.pack);
    if (!pack) return { error: `Pack not found: ${params.pack}` };

    let doc;
    if (params.id) {
      doc = await pack.getDocument(params.id);
    } else if (params.name) {
      if (!pack.index.size) await pack.getIndex();
      const entry = Array.from(pack.index.values()).find(
        e => e.name.toLowerCase() === params.name.toLowerCase()
      );
      if (entry) doc = await pack.getDocument(entry._id);
    }

    if (!doc) return { error: `Document not found in ${params.pack}` };
    return doc.toObject();
  },

  /** List items (world-level) */
  list_items: (params = {}) => {
    let items = game.items.contents;
    if (params.type) {
      items = items.filter(i => i.type === params.type);
    }
    return items.map(i => ({
      id: i.id,
      name: i.name,
      type: i.type,
      folder: i.folder?.name ?? null
    }));
  },

  /** Full item data */
  get_item: (params = {}) => {
    const item = params.id
      ? game.items.get(params.id)
      : game.items.getName(params.name);
    if (!item) return { error: `Item not found: ${params.id || params.name}` };
    return item.toObject();
  },

  /** Active Effects on a given actor */
  get_active_effects: (params = {}) => {
    const actor = params.id
      ? game.actors.get(params.id)
      : game.actors.getName(params.name);
    if (!actor) return { error: `Actor not found: ${params.id || params.name}` };
    return actor.effects.contents.map(e => e.toObject());
  },

  /** Current scene info */
  get_scene: () => {
    const scene = game.scenes.active;
    if (!scene) return { error: "No active scene" };
    return {
      id: scene.id,
      name: scene.name,
      dimensions: { width: scene.width, height: scene.height },
      grid: { size: scene.grid.size, type: scene.grid.type },
      tokens: scene.tokens.contents.map(t => ({
        id: t.id,
        name: t.name,
        actorId: t.actorId,
        x: t.x,
        y: t.y,
        elevation: t.elevation,
        hidden: t.hidden
      }))
    };
  },

  /** Recent console errors/warnings, optionally scoped by time window or
   * level. Defaults `sinceMs` to 60_000 (last 60s) since the unbounded
   * form is almost always too noisy to be useful — pass `sinceMs: 0` to
   * disable the time filter explicitly. */
  get_console_errors: (params = {}) => {
    const count = params.count ?? MAX_ERRORS;
    const sinceMs = (typeof params.sinceMs === "number") ? params.sinceMs : 60_000;
    const level = params.level;

    let entries = errorBuffer;
    if (sinceMs > 0) {
      const cutoff = Date.now() - sinceMs;
      entries = entries.filter(e => e.timestamp >= cutoff);
    }
    if (level === "error" || level === "warn") {
      entries = entries.filter(e => e.level === level);
    }
    return {
      bufferSize: errorBuffer.length,
      bufferCapacity: MAX_ERRORS,
      sinceMs,
      returned: Math.min(entries.length, count),
      entries: entries.slice(-count)
    };
  },

  /** Retrieve the system data model template for a given document type */
  get_data_model: (params = {}) => {
    const type = params.type ?? "Actor";
    const template = game.system.template?.[type] ?? null;
    if (template) return template;

    // Fallback: sample a document of the requested type (and subtype if given)
    // and return its system data so callers can introspect the live shape even
    // when the system declares no static template for the type.
    const collection = type === "Actor" ? game.actors
                     : type === "Item"  ? game.items
                     : null;
    if (!collection) return { error: "No template or sample data found" };

    const candidates = params.subtype
      ? collection.contents.filter(d => d.type === params.subtype)
      : collection.contents;
    const sample = candidates[0];
    if (sample) return { _sampleFrom: sample.name, system: sample.toObject().system };

    return { error: "No template or sample data found" };
  },

  /** List journal entries */
  list_journals: (params = {}) => {
    let journals = game.journal.contents;
    if (params.folder) {
      journals = journals.filter(j => j.folder?.name === params.folder);
    }
    return journals.map(j => ({
      id: j.id,
      name: j.name,
      folder: j.folder?.name ?? null,
      pages: j.pages.contents.map(p => ({ id: p.id, name: p.name, type: p.type }))
    }));
  },

  /** List roll tables */
  list_tables: () => {
    return game.tables.contents.map(t => ({
      id: t.id,
      name: t.name,
      formula: t.formula,
      results: t.results.size
    }));
  },

  /** List macros */
  list_macros: () => {
    return game.macros.contents.map(m => ({
      id: m.id,
      name: m.name,
      type: m.type,
      command: m.command?.substring(0, 200) + (m.command?.length > 200 ? "..." : "")
    }));
  },

  /** Get full macro source */
  get_macro: (params = {}) => {
    const macro = params.id
      ? game.macros.get(params.id)
      : game.macros.getName(params.name);
    if (!macro) return { error: `Macro not found: ${params.id || params.name}` };
    return macro.toObject();
  },

  /**
   * Screenshot the PIXI game canvas. Returns a base64 image.
   * Scales down + JPEG-compresses to keep payloads small.
   */
  screenshot: async (params = {}) => {
    // Render the stage to a RenderTexture sized to the viewport so the output
    // matches what the user sees (pan/zoom already baked into the stage
    // transform). Reading canvas.app.view directly returns black because the
    // WebGL context is created with preserveDrawingBuffer:false.
    const renderer = canvas?.app?.renderer;
    const stage    = canvas?.stage;
    if (!renderer || !stage) return { error: "Canvas not ready" };

    const scale   = Math.min(Math.max(params.scale ?? 0.5, 0.1), 1);
    const quality = Math.min(Math.max(params.quality ?? 0.7, 0.1), 1);
    const format  = params.format === "png" ? "png" : "jpeg";
    const mime    = `image/${format}`;

    const screenW = renderer.screen.width;
    const screenH = renderer.screen.height;

    const rt = PIXI.RenderTexture.create({ width: screenW, height: screenH, resolution: 1 });
    let source;
    try {
      renderer.render(stage, { renderTexture: rt, clear: true });
      source = renderer.extract.canvas(rt);
    } finally {
      rt.destroy(true);
    }

    const w = Math.round(screenW * scale);
    const h = Math.round(screenH * scale);

    const tmp = document.createElement("canvas");
    tmp.width  = w;
    tmp.height = h;
    const ctx = tmp.getContext("2d");
    if (format === "jpeg") {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, w, h);
    }
    ctx.drawImage(source, 0, 0, w, h);

    const dataUrl = tmp.toDataURL(mime, quality);
    const base64  = dataUrl.split(",")[1];

    return { image: base64, mimeType: mime, width: w, height: h };
  },

  /**
   * Screenshot a DOM element (sheets, HUD, chat cards — anything the PIXI
   * screenshot can't reach) via html2canvas, lazy-loaded from the module's
   * vendored copy on first use and cached on window. Useful for UI diffing
   * and comparing sheet layouts. Note: html2canvas approximates some CSS
   * (3D transforms, shaders, cross-origin images without CORS headers may
   * be blank).
   */
  screenshot_dom: async (params = {}) => {
    const selector = params.selector ?? "body";
    const scale    = Math.min(Math.max(params.scale   ?? 0.75, 0.1), 1);
    const quality  = Math.min(Math.max(params.quality ?? 0.8,  0.1), 1);
    const format   = params.format === "jpeg" ? "jpeg" : "png";
    const mime     = `image/${format}`;

    let h2c = globalThis._mcp_html2canvas;
    if (!h2c) {
      try {
        const mod = await import("/modules/foundry-mcp-live/lib/html2canvas.esm.js");
        h2c = mod.default || mod;
        globalThis._mcp_html2canvas = h2c;
      } catch (err) {
        return { error: `Failed to load vendored html2canvas: ${err.message}` };
      }
    }

    const el = document.querySelector(selector);
    if (!el) return { error: `Element not found: ${selector}` };

    let rendered;
    try {
      rendered = await h2c(el, { scale, logging: false, backgroundColor: format === "jpeg" ? "#000" : null, useCORS: true });
    } catch (err) {
      return { error: `html2canvas failed: ${err.message}` };
    }

    const dataUrl = rendered.toDataURL(mime, quality);
    const base64  = dataUrl.split(",")[1];
    return {
      image:    base64,
      mimeType: mime,
      width:    rendered.width,
      height:   rendered.height,
      selector,
      element:  { tag: el.tagName.toLowerCase(), class: el.className || null, id: el.id || null }
    };
  },

  /**
   * Capture the active scene canvas as a base64 WebP with a coordinate grid
   * overlay (gx,gy labels per cell). Uses a RenderTexture extract so the
   * overlay actually appears in the output (the live WebGL drawing buffer is
   * typically not preserved).
   */
  capture_scene: async () => {
    const renderer = canvas?.app?.renderer;
    const stage    = canvas?.stage;
    const scene    = canvas?.scene;
    if (!renderer || !stage || !scene) return { error: "Canvas not ready" };

    const overlay = _addGridOverlay(canvas);
    const screenW = renderer.screen.width;
    const screenH = renderer.screen.height;
    const mime    = "image/webp";

    const rt = PIXI.RenderTexture.create({ width: screenW, height: screenH, resolution: 1 });
    let base64;
    try {
      renderer.render(stage, { renderTexture: rt, clear: true });
      const source  = renderer.extract.canvas(rt);
      const dataUrl = source.toDataURL(mime, 0.8);
      base64 = dataUrl.split(",")[1];
    } finally {
      rt.destroy(true);
      _removeGridOverlay(canvas, overlay);
    }

    return {
      sceneId:   scene.id,
      sceneName: scene.name,
      image:     base64,
      mimeType:  mime,
      width:     Math.round(screenW),
      height:    Math.round(screenH)
    };
  },

  /**
   * Register a temporary listener on a named Foundry hook, collect up to
   * `count` firings (or until `timeoutMs`), unregister, and return the
   * serialized arguments of each invocation.
   */
  trace_hook: async (params = {}) => {
    const name      = params.hook;
    const count     = Math.min(Math.max(params.count ?? 1, 1), 20);
    const timeoutMs = Math.min(Math.max(params.timeoutMs ?? 5000, 100), 12000);

    if (!name) return { error: "hook name is required" };

    const firings = [];
    let hookId;
    let resolved = false;

    return await new Promise((resolve) => {
      const finish = (reason) => {
        if (resolved) return;
        resolved = true;
        try { Hooks.off(name, hookId); } catch {}
        clearTimeout(timer);
        resolve({ hook: name, reason, firings });
      };

      const timer = setTimeout(() => finish("timeout"), timeoutMs);

      hookId = Hooks.on(name, (...args) => {
        firings.push({
          at:   Date.now(),
          args: args.map(a => safeSerializeHookArg(a))
        });
        if (firings.length >= count) finish("count");
      });
    });
  },

  /**
   * Register listeners on multiple Foundry hooks at once and return a single
   * time-ordered timeline of every firing. Each entry is { at, dt, hook, args }
   * where `dt` is ms since the first firing. Useful for diagnosing hook-order
   * bugs (e.g. patches firing out of sequence relative to the system).
   *
   * Stops when total firings across all hooks reaches `count`, or `timeoutMs`
   * elapses. If `until` is provided, also stops when that hook fires (handy
   * for "trace everything until renderApplication").
   */
  trace_hooks: async (params = {}) => {
    const hooks     = Array.isArray(params.hooks) ? params.hooks : [];
    const count     = Math.min(Math.max(params.count ?? 50, 1), 500);
    const timeoutMs = Math.min(Math.max(params.timeoutMs ?? 5000, 100), 30000);
    const until     = typeof params.until === "string" ? params.until : null;

    if (hooks.length === 0) return { error: "hooks (array of hook names) is required" };

    const timeline = [];
    const registry = []; // [{ name, id }]
    let resolved = false;
    let t0 = null;

    return await new Promise((resolve) => {
      const finish = (reason) => {
        if (resolved) return;
        resolved = true;
        for (const { name, id } of registry) { try { Hooks.off(name, id); } catch {} }
        clearTimeout(timer);
        resolve({ hooks, reason, total: timeline.length, timeline });
      };

      const timer = setTimeout(() => finish("timeout"), timeoutMs);

      for (const name of hooks) {
        const id = Hooks.on(name, (...args) => {
          const at = Date.now();
          if (t0 === null) t0 = at;
          timeline.push({
            at,
            dt:   at - t0,
            hook: name,
            args: args.map(a => safeSerializeHookArg(a))
          });
          if (until && name === until) return finish("until");
          if (timeline.length >= count) finish("count");
        });
        registry.push({ name, id });
      }
    });
  },

  /**
   * Tap game.socket for a window. Wraps `socket.emit` for outgoing and uses
   * Socket.IO's `onAny` for incoming. Returns a single time-ordered list of
   * { at, dt, dir: "in"|"out", event, args }. Optional `filter` is a substring
   * matched against event names (e.g. "module.vagabond-crawler").
   *
   * Caveat: monkeypatches socket.emit for the duration. Don't call twice in
   * parallel.
   */
  trace_socket: async (params = {}) => {
    const timeoutMs = Math.min(Math.max(params.timeoutMs ?? 5000, 100), 30000);
    const count     = Math.min(Math.max(params.count     ?? 100,  1), 1000);
    const filter    = params.filter;

    if (!game.socket) return { error: "game.socket not available" };

    const events       = [];
    const t0           = Date.now();
    const sock         = game.socket;
    const origEmit     = sock.emit.bind(sock);
    const supportsOnAny = typeof sock.onAny === "function";
    const matches = (name) =>
      !filter || (typeof name === "string" && name.includes(filter));

    let resolved = false;
    let incomingHandler = null;

    return await new Promise((resolve) => {
      const finish = (reason) => {
        if (resolved) return;
        resolved = true;
        sock.emit = origEmit;
        if (incomingHandler) { try { sock.offAny(incomingHandler); } catch {} }
        clearTimeout(timer);
        resolve({ reason, total: events.length, supportsOnAny, filter: filter ?? null, events });
      };

      const record = (dir, event, args) => {
        if (!matches(event)) return;
        events.push({
          at:    Date.now(),
          dt:    Date.now() - t0,
          dir,
          event,
          args:  args.map(a => safeSerializeHookArg(a)),
        });
        if (events.length >= count) finish("count");
      };

      sock.emit = (event, ...args) => {
        record("out", event, args);
        return origEmit(event, ...args);
      };

      if (supportsOnAny) {
        incomingHandler = (event, ...args) => record("in", event, args);
        sock.onAny(incomingHandler);
      }

      const timer = setTimeout(() => finish("timeout"), timeoutMs);
    });
  },

  /**
   * Snapshot an actor's current state as plain JSON. Optional `scope` array
   * limits which top-level sections are included: "system", "flags", "items",
   * "effects", "prototypeToken". Default: everything except prototypeToken.
   *
   * Returns a plain JSON object suitable for later passing to diff_actor.
   */
  snapshot_actor: (params = {}) => {
    const actor = game.actors.get(params.actor) ?? game.actors.getName(params.actor);
    if (!actor) return { error: `Actor not found: ${params.actor}` };

    const requested = Array.isArray(params.scope) && params.scope.length > 0
      ? new Set(params.scope)
      : null;
    const wants = (s) => !requested || requested.has(s);

    const obj = actor.toObject();
    const snap = {
      _kind: "actor-snapshot",
      _at:   Date.now(),
      id:    actor.id,
      name:  actor.name,
      type:  actor.type,
    };
    if (wants("system"))         snap.system         = obj.system;
    if (wants("flags"))          snap.flags          = obj.flags;
    if (wants("items"))          snap.items          = obj.items;
    if (wants("effects"))        snap.effects        = obj.effects;
    if (requested?.has("prototypeToken")) snap.prototypeToken = obj.prototypeToken;
    return snap;
  },

  /**
   * Compute the structural delta between two actor snapshots (or any two
   * JSON structures). Arrays whose elements have `_id` are matched by id so
   * reordering does not show up as a change. Useful for verifying that a
   * patch only modified what it was supposed to.
   *
   * Pass either { before, after } as inline JSON, or { actor, before } to
   * diff a previous snapshot against the actor's *current* state.
   */
  diff_actor: (params = {}) => {
    let before = params.before;
    let after  = params.after;

    if (!after && params.actor) {
      const actor = game.actors.get(params.actor) ?? game.actors.getName(params.actor);
      if (!actor) return { error: `Actor not found: ${params.actor}` };
      const obj = actor.toObject();
      after = {
        _kind: "actor-snapshot", _at: Date.now(),
        id: actor.id, name: actor.name, type: actor.type,
      };
      // Mirror whichever sections the `before` snapshot contains, so a
      // scoped snapshot (e.g. flags-only) doesn't produce spurious "added"
      // entries for sections we never captured.
      const sectionKeys = ["system", "flags", "items", "effects", "prototypeToken"];
      const allSections = {
        system: obj.system, flags: obj.flags, items: obj.items,
        effects: obj.effects, prototypeToken: obj.prototypeToken,
      };
      const beforeHas = (k) => before && Object.prototype.hasOwnProperty.call(before, k);
      let matched = false;
      for (const k of sectionKeys) {
        if (beforeHas(k)) { after[k] = allSections[k]; matched = true; }
      }
      // Fallback: if `before` had no recognized sections, include the defaults
      if (!matched) {
        after.system = obj.system; after.flags = obj.flags;
        after.items = obj.items; after.effects = obj.effects;
      }
    }

    if (!before || !after) return { error: "diff_actor needs `before` and either `after` or `actor`" };

    const ignore = ["_at"]; // volatile snapshot metadata
    const trim = (obj) => {
      if (!obj || typeof obj !== "object") return obj;
      const out = { ...obj };
      for (const k of ignore) delete out[k];
      return out;
    };

    const changes = deepDiff(trim(before), trim(after));
    return {
      total:   changes.length,
      changes,
      summary: changes.reduce((acc, c) => { acc[c.op] = (acc[c.op] ?? 0) + 1; return acc; }, {}),
    };
  },

  /**
   * Evaluate a dice formula with optional rigged results.
   * rig: [15, 4, 4, 4] forces successive dice to those face values.
   */
  roll: async (params = {}) => {
    if (!params.formula) return { error: "formula is required" };
    try {
      const roll = await withRiggedDice(params.rig, async () => {
        const r = new Roll(params.formula);
        await r.evaluate();
        return r;
      });
      return summariseRoll(roll);
    } catch (err) {
      return { error: err.message, stack: err.stack };
    }
  },

  /**
   * Trigger an item on an actor (weapon, spell, feature) and capture the
   * resulting chat messages. Many Vagabond item methods (rollAttack,
   * rollDamage) need sheet context and fail headlessly — prefer the `click`
   * tool which drives the real DOM click path.
   */
  use_item: async (params = {}) => {
    const actor = game.actors.get(params.actor) ?? game.actors.getName(params.actor);
    if (!actor) return { error: `Actor not found: ${params.actor}` };

    const item = actor.items.get(params.item) ?? actor.items.getName(params.item);
    if (!item) return { error: `Item not found on ${actor.name}: ${params.item}` };

    const method = params.method ?? (typeof item.use === "function" ? "use" : "roll");
    if (typeof item[method] !== "function") {
      return { error: `Item ${item.name} has no ${method}() method.` };
    }

    try {
      const { messages } = await runWithCapture({ rig: params.rig }, () => item[method]());
      return { actor: actor.name, item: item.name, method, messagesCreated: messages.length, messages };
    } catch (err) {
      return { error: err.message, stack: err.stack };
    }
  },

  // -------------------------------------------------------------------------
  // Token manipulation — all operate on the active scene unless otherwise
  // noted. Token references accept the document id, the token name, or the
  // linked actor name.
  // -------------------------------------------------------------------------

  /** List/find conditions available in the current system (for toggle_token_condition). */
  get_available_conditions: () => {
    return (CONFIG.statusEffects || []).map(e => ({
      id: e.id,
      label: game.i18n?.localize?.(e.name ?? e.label) ?? (e.name ?? e.label),
      icon: e.img ?? e.icon ?? null,
      hud: e.hud ?? null
    }));
  },

  /** Full details for a token including linked actor and active conditions. */
  get_token_details: (params = {}) => {
    const scene = game.scenes.active;
    if (!scene) return { error: "No active scene" };
    const t = _findToken(scene, params.token);
    if (!t) return { error: `Token not found: ${params.token}` };

    const obj = t.toObject();
    const actor = t.actor;
    return {
      id: t.id,
      name: t.name,
      x: t.x, y: t.y,
      width: t.width, height: t.height,
      rotation: t.rotation,
      elevation: t.elevation,
      hidden: t.hidden,
      disposition: t.disposition,
      lockRotation: t.lockRotation,
      sort: t.sort,
      img: obj.texture?.src ?? null,
      sight: obj.sight ?? null,
      light: obj.light ?? null,
      actor: actor ? {
        id: actor.id,
        name: actor.name,
        type: actor.type,
        system: actor.toObject().system,
        statuses: Array.from(actor.statuses ?? []),
        effects: actor.effects.contents.map(e => ({ id: e.id, name: e.name, statuses: Array.from(e.statuses ?? []), disabled: e.disabled }))
      } : null
    };
  },

  /** Move a token to (x, y) on the active scene with optional animation. */
  move_token: async (params = {}) => {
    const scene = game.scenes.active;
    if (!scene) return { error: "No active scene" };
    const t = _findToken(scene, params.token);
    if (!t) return { error: `Token not found: ${params.token}` };
    if (typeof params.x !== "number" || typeof params.y !== "number") {
      return { error: "x and y are required numbers" };
    }
    const animation = params.animate === false ? { duration: 0 } : undefined;
    await t.update({ x: params.x, y: params.y }, animation ? { animation } : {});
    return { id: t.id, name: t.name, x: t.x, y: t.y };
  },

  /**
   * Move a token to (x,y) using A* pathfinding against scene walls on the
   * active scene. Falls back to a plain teleport if no polygon backend or
   * grid size is available. Set `canOpenDoors` to have the token open closed
   * doors along its path (door ids returned in `doorsOpened`). Only the final
   * waypoint carries animation — intermediate hops teleport.
   */
  move_token_pathed: async (params = {}) => {
    const scene = game.scenes.active;
    if (!scene) return { error: "No active scene" };
    const t = _findToken(scene, params.token);
    if (!t) return { error: `Token not found: ${params.token}` };
    if (typeof params.x !== "number" || typeof params.y !== "number") {
      return { error: "x and y are required numbers" };
    }

    const animate  = params.animate !== false;
    const backend  = CONFIG?.Canvas?.polygonBackends?.move;
    const gridSize = canvas?.scene?.grid?.size;

    const finalExtras = {};
    if (params.elevation !== undefined) finalExtras.elevation = params.elevation;
    if (params.rotation  !== undefined) finalExtras.rotation  = params.rotation;

    // Fallback — no collision backend / grid: plain teleport
    if (!backend || !gridSize) {
      const opts = animate ? {} : { animation: { duration: 0 } };
      await t.update({ x: params.x, y: params.y, ...finalExtras }, opts);
      return { id: t.id, name: t.name, x: t.x, y: t.y, pathCost: null, doorsOpened: [] };
    }

    const tokenW = t.width;
    const tokenH = t.height;

    let collision = backend;
    let openable = [];
    const useDoorAware = !!params.canOpenDoors && !!scene.walls?.contents?.length;
    if (useDoorAware) {
      const wallInfos = scene.walls.contents.map(w => ({
        _id: w._id ?? w.id, c: w.c, door: w.door, ds: w.ds ?? 0, move: w.move
      }));
      collision = _createDoorAwareCollision(backend, wallInfos);
      openable  = wallInfos.filter(w => w.door === 1 && w.ds === 0 && w.move !== 0);
    }

    const directBlocked = _cellsBlocked(
      t.x, t.y, params.x, params.y, tokenW, tokenH, gridSize, collision
    );

    let path = null;
    let pathCost = 0;
    if (directBlocked) {
      const result = _findGridPath({
        startX: t.x, startY: t.y, endX: params.x, endY: params.y,
        gridSize, collision, tokenWidth: tokenW, tokenHeight: tokenH
      });
      if (!result || result.path.length === 0) {
        return { error: "Path blocked — no valid route to destination" };
      }
      path = result.path;
      pathCost = result.cost;
    } else {
      path = [{ x: params.x, y: params.y }];
    }

    const doorsOnPath = useDoorAware
      ? _findDoorsAlongPath(path, t.x, t.y, gridSize, openable)
      : [];
    const doorsByStep = new Map();
    for (const d of doorsOnPath) {
      const idx = d.betweenIndex - 1;
      const arr = doorsByStep.get(idx) ?? [];
      arr.push(d);
      doorsByStep.set(idx, arr);
    }

    const doorsOpened = [];
    let current = t;
    for (let i = 0; i < path.length; i++) {
      const wp = path[i];
      const doorsHere = doorsByStep.get(i);

      if (doorsHere && scene.walls) {
        for (const door of doorsHere) {
          const wall = scene.walls.get(door.wallId);
          if (wall && wall.door !== 0 && (wall.ds === 0 || wall.ds === undefined)) {
            await wall.update({ ds: 1 });
            doorsOpened.push(door.wallId);
            await _delay(_DOOR_OPEN_DELAY);
          }
        }
      }

      const isLast         = i === path.length - 1;
      const upd            = { x: wp.x, y: wp.y, ...(isLast ? finalExtras : {}) };
      const shouldAnimate  = isLast && animate;
      const opts           = {};
      if (!shouldAnimate) opts.animation = { duration: 0 };
      if (doorsHere)      opts.teleport  = true;

      await current.update(upd, opts);
      const refreshed = scene.tokens.get(current.id);
      if (!refreshed) return { error: "Token lost during movement" };
      current = refreshed;
    }

    return {
      id: current.id,
      name: current.name,
      x: current.x,
      y: current.y,
      pathCost,
      doorsOpened
    };
  },

  /** Update arbitrary token properties: position, size, rotation, hidden, disposition, etc. */
  update_token: async (params = {}) => {
    const scene = game.scenes.active;
    if (!scene) return { error: "No active scene" };
    const t = _findToken(scene, params.token);
    if (!t) return { error: `Token not found: ${params.token}` };
    if (!params.updates || typeof params.updates !== "object") {
      return { error: "updates object is required" };
    }
    // Whitelist top-level keys to avoid accidental destructive writes.
    // `flags` is included so module-specific data (e.g. Levels module's
    // flags.levels.rangeTop/rangeBottom for elevation-aware scenes) can be
    // set without falling back to evaluate. Foundry's document.update does a
    // deep merge on flags, so existing module flags are preserved.
    const allowed = ["x", "y", "width", "height", "rotation", "hidden", "disposition", "name", "elevation", "lockRotation", "sort", "alpha", "tint", "flags"];
    const updates = {};
    for (const k of allowed) if (k in params.updates) updates[k] = params.updates[k];
    if (Object.keys(updates).length === 0) {
      return { error: `No allowed fields in updates. Allowed: ${allowed.join(", ")}` };
    }
    await t.update(updates);
    return { id: t.id, name: t.name, applied: updates };
  },

  /** Delete one or more tokens from the active scene. */
  delete_tokens: async (params = {}) => {
    const scene = game.scenes.active;
    if (!scene) return { error: "No active scene" };
    const refs = Array.isArray(params.tokens) ? params.tokens : [params.tokens].filter(Boolean);
    if (refs.length === 0) return { error: "tokens array is required" };

    const ids = [];
    const missing = [];
    for (const r of refs) {
      const t = _findToken(scene, r);
      if (t) ids.push(t.id); else missing.push(r);
    }
    if (ids.length === 0) return { error: "No matching tokens found", missing };

    await scene.deleteEmbeddedDocuments("Token", ids);
    return { deleted: ids, missing };
  },

  /** Toggle a status effect on a token's actor. */
  toggle_token_condition: async (params = {}) => {
    const scene = game.scenes.active;
    if (!scene) return { error: "No active scene" };
    const t = _findToken(scene, params.token);
    if (!t) return { error: `Token not found: ${params.token}` };
    if (!params.condition) return { error: "condition is required" };
    if (!t.actor) return { error: "Token has no linked actor" };

    const effect = (CONFIG.statusEffects || []).find(e =>
      e.id === params.condition ||
      e.name === params.condition ||
      (e.label && e.label === params.condition)
    );
    if (!effect) return { error: `Unknown condition: ${params.condition}` };

    // v13: Actor.toggleStatusEffect handles add/remove/toggle
    const newState = await t.actor.toggleStatusEffect(effect.id, { active: params.active });
    return {
      id: t.id,
      name: t.name,
      condition: effect.id,
      active: newState !== false,
      statuses: Array.from(t.actor.statuses ?? [])
    };
  },

  /**
   * Set the user's current targets to the named tokens on the active scene.
   * Pass token names or ids; missing tokens are reported in the response.
   * Use this before `click`-ing an attack so the system can compute hits
   * against real defenses. Pass an empty array to clear targets.
   */
  target: async (params = {}) => {
    const list = Array.isArray(params.tokens) ? params.tokens
                : params.tokens != null ? [params.tokens] : [];

    if (!canvas?.ready) return { error: "Canvas not ready" };
    const placeables = canvas.tokens?.placeables ?? [];

    const found = [];
    const missing = [];
    for (const ref of list) {
      const t = placeables.find(p => p.id === ref || p.document?.id === ref || p.name === ref || p.actor?.name === ref);
      if (t) found.push(t); else missing.push(ref);
    }

    // Clear existing targets first, then set new ones (atomic from user POV)
    for (const t of [...game.user.targets]) t.setTarget(false, { user: game.user, releaseOthers: false, groupSelection: true });
    for (const t of found) t.setTarget(true,  { user: game.user, releaseOthers: false, groupSelection: true });

    return {
      targeted: found.map(t => ({ id: t.id, name: t.name, actor: t.actor?.name ?? null, hp: t.actor?.system?.hp ?? null })),
      missing,
      total: found.length
    };
  },

  /**
   * Simulate a player clicking a DOM element (character sheet button, chat
   * card action button, etc.). This exercises the real dispatch path the
   * system is designed around, with optional dice rigging for deterministic
   * test results. Captures any chat messages produced during the click.
   *
   * If `openActor` is provided, the actor's sheet is rendered first (and
   * waited on) so its buttons exist in the DOM when the selector runs.
   */
  click: async (params = {}) => {
    if (!params.selector) return { error: "selector is required" };

    // Optionally open an actor sheet first so its buttons are in the DOM
    if (params.openActor) {
      const actor = game.actors.get(params.openActor) ?? game.actors.getName(params.openActor);
      if (!actor) return { error: `openActor not found: ${params.openActor}` };
      const sheet = actor.sheet;
      if (!sheet.rendered) {
        await sheet.render(true);
        // Wait for the sheet to finish rendering in the DOM
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline && !document.querySelector(`[data-appid="${sheet.appId}"], .app[data-appid="${sheet.appId}"]`)) {
          await new Promise(r => setTimeout(r, 50));
        }
      }
    }

    const el = document.querySelector(params.selector);
    if (!el) return { error: `Element not found: ${params.selector}` };

    const elementInfo = {
      tag: el.tagName.toLowerCase(),
      class: el.className || null,
      id: el.id || null,
      dataset: { ...el.dataset },
      text: (el.textContent || "").trim().slice(0, 80)
    };

    try {
      const { messages } = await runWithCapture(
        { rig: params.rig, waitMs: params.waitMs ?? 400 },
        async () => {
          // Use the native HTMLElement.click() which dispatches a bubbling
          // click event — picks up both direct and delegated listeners.
          el.click();
        }
      );
      return { selector: params.selector, element: elementInfo, messagesCreated: messages.length, messages };
    } catch (err) {
      return { error: err.message, stack: err.stack, element: elementInfo };
    }
  },

  /**
   * Click a button on the topmost open DialogV2 dialog. Used by the
   * `simulate_dialog_response` MCP tool when a sheet/macro action opens
   * a confirmation or options prompt and the test needs to drive that
   * prompt without a stable CSS selector.
   *
   * Match strategy:
   *   - `label` (string)  → first button whose visible text contains it
   *                         (case-insensitive). Mutually exclusive with `index`.
   *   - `index` (number)  → zero-based button position in the dialog.
   * Returns `{ dialogTitle, clickedLabel, clickedIndex, totalButtons }`
   * on success, or `{ error, available }` listing button labels on miss.
   */
  simulate_dialog_response: async (params = {}) => {
    const { label, index } = params;
    if (label == null && index == null) {
      return { error: "Provide either `label` (string) or `index` (number)." };
    }
    if (label != null && index != null) {
      return { error: "Provide only one of `label` or `index`, not both." };
    }

    // DialogV2 is registered in foundry.applications.api.DialogV2 (v13).
    // foundry.applications.instances is a Map keyed by app id.
    const DialogV2 = foundry.applications?.api?.DialogV2;
    if (!DialogV2) return { error: "DialogV2 not available in this Foundry version." };

    const dialogs = [...(foundry.applications.instances?.values() ?? [])]
      .filter(app => app instanceof DialogV2 && app.rendered);
    if (dialogs.length === 0) return { error: "No DialogV2 dialog is currently open." };

    // Topmost = most recently rendered. Foundry's PopOver tracking uses
    // _renderTime / position.zIndex; cheapest reliable proxy is "highest
    // app id" because instances are added in render order.
    const dialog = dialogs.sort((a, b) => (b.appId ?? 0) - (a.appId ?? 0))[0];
    const root = dialog.element;
    if (!root) return { error: "Topmost dialog has no rendered element." };

    // DialogV2 buttons live in the .form-footer section as <button> with
    // data-action set to the option's `action` (or auto-generated). Fall
    // back to all <button> elements if the structure differs.
    let buttons = [...root.querySelectorAll(".form-footer button, .dialog-buttons button")];
    if (buttons.length === 0) buttons = [...root.querySelectorAll("button")];
    if (buttons.length === 0) return { error: "Topmost dialog has no buttons." };

    const labels = buttons.map(b => (b.textContent || "").trim());

    let target = null;
    let targetIndex = -1;
    if (label != null) {
      const needle = String(label).trim().toLowerCase();
      targetIndex = labels.findIndex(t => t.toLowerCase().includes(needle));
      if (targetIndex < 0) {
        return { error: `No button label contains "${label}".`, available: labels };
      }
      target = buttons[targetIndex];
    } else {
      const idx = Number(index) | 0;
      if (idx < 0 || idx >= buttons.length) {
        return { error: `Index ${idx} out of range (${buttons.length} buttons).`, available: labels };
      }
      targetIndex = idx;
      target = buttons[idx];
    }

    target.click();

    return {
      dialogTitle:  dialog.options?.window?.title ?? dialog.title ?? null,
      clickedLabel: labels[targetIndex],
      clickedIndex: targetIndex,
      totalButtons: buttons.length,
    };
  },

  /**
   * Multi-actor structured projection.
   *
   * Selector grammar (each entry in `select`):
   *   - `system.health.value`        → dot path to a single value/subtree
   *   - `effects[*].name`            → array wildcard, projects each element
   *   - `effects[].name`             → alias for `[*]`
   *   - `items[2].system.quantity`   → numeric index, projects one element
   *   - `flags.vagabond`             → returns the whole subtree
   *
   * Wildcards may chain: `items[*].effects[*].name` projects a nested array.
   *
   * Returns `{ actors: { actorId: { _name, <selector>: value, ... }, ... },
   * takenAt }`. If `select` is omitted, each actor's full `.toObject()` is
   * captured under the `_full` key.
   *
   * Used by the `snapshot_actors` and `diff_with` MCP tools.
   */
  snapshot_actors: async (params = {}) => {
    const refs = Array.isArray(params.actors) ? params.actors : [params.actors];
    if (refs.length === 0 || refs.some(r => !r)) {
      return { error: "Provide a non-empty `actors` (string or array of strings)." };
    }
    const select = (Array.isArray(params.select) && params.select.length > 0) ? params.select : null;

    const out = {};
    const errors = [];
    for (const ref of refs) {
      const actor = game.actors.get(ref) ?? game.actors.getName(ref);
      if (!actor) { errors.push(`Actor not found: ${ref}`); continue; }

      if (!select) {
        // No selectors → fall back to the persisted source via toObject.
        // Note: this path does NOT include derived data (effects-applied
        // values, prepareDerivedData patches) or getter-only properties
        // like `actor.statuses`. Pass an explicit `select` to get those.
        out[actor.id] = { _name: actor.name, _full: actor.toObject() };
      } else {
        // Walk the LIVE actor so projections capture derived data.
        const proj = { _name: actor.name };
        for (const path of select) {
          proj[path] = projectPath(actor, path);
        }
        out[actor.id] = proj;
      }
    }

    return {
      actors: out,
      takenAt: Date.now(),
      ...(errors.length ? { errors } : {}),
    };
  },

  /**
   * Evaluate an arbitrary JS expression in the Foundry context.
   * This is the power tool — use with care.
   *
   * Returns `{ result, evalMs }` so callers can distinguish slow user
   * code from slow bridge / network. `result` is the JSON-serializable
   * form of the eval's return value (Foundry documents go through
   * `.toObject()` automatically).
   */
  evaluate: async (params = {}) => {
    if (!params.expression) return { error: "No expression provided" };
    const t0 = performance.now();
    try {
      const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
      const fn = new AsyncFunction("game", "canvas", "ui", params.expression);
      const raw = await fn(game, canvas, ui);
      const evalMs = +(performance.now() - t0).toFixed(2);

      // Attempt to serialise — toObject() if it's a Foundry document
      const result = (raw?.toObject)
        ? raw.toObject()
        : JSON.parse(JSON.stringify(raw ?? null));
      return { result, evalMs };
    } catch (err) {
      const evalMs = +(performance.now() - t0).toFixed(2);
      return { error: err.message, stack: err.stack, evalMs };
    }
  },

  // -------------------------------------------------------------------------
  // World authoring — server-side these tools are only registered when
  // FOUNDRY_MCP_ALLOW_WRITE=1, so a default-config server can't reach them
  // even if the bridge is online. Handlers throw on bad input; the bridge's
  // top-level dispatcher converts that to a structured error.
  // -------------------------------------------------------------------------

  /**
   * Create a folder (idempotent on `type + name + parentFolder`). When a
   * folder with the same triple already exists, return it with `existed: true`
   * instead of creating a duplicate.
   */
  create_folder: async (params = {}) => {
    const { type, name, parentFolder, color } = params;
    if (!type || !name) throw new Error("`type` and `name` are required");

    let parentId = null;
    if (parentFolder) {
      const parent = game.folders.get(parentFolder)
        ?? game.folders.find(f => f.type === type && f.name === parentFolder);
      if (!parent) throw new Error(`Parent folder "${parentFolder}" not found for type ${type}`);
      parentId = parent.id;
    }

    const existing = game.folders.find(f =>
      f.type === type && f.name === name && (f.folder?.id ?? null) === parentId
    );
    if (existing) {
      return { id: existing.id, name: existing.name, type: existing.type, parent: parentId, existed: true };
    }

    const created = await Folder.create({
      name, type,
      folder: parentId,
      ...(color ? { color } : {})
    });
    return { id: created.id, name: created.name, type: created.type, parent: parentId, existed: false };
  },

  /**
   * Import an actor from a compendium pack into the world. The folder is
   * resolved by id, then by exact name (auto-created if missing).
   */
  create_actor_from_compendium: async (params = {}) => {
    const { pack, documentId, folderId, folderName, nameOverride } = params;
    if (!pack || !documentId) throw new Error("`pack` and `documentId` are required");

    const compendium = game.packs.get(pack);
    if (!compendium) throw new Error(`Compendium pack "${pack}" not found`);
    if (compendium.metadata.type !== "Actor") {
      throw new Error(`Pack "${pack}" holds ${compendium.metadata.type} documents, not Actor`);
    }

    const resolvedFolderId = await _resolveFolder("Actor", folderId, folderName, true);

    const imported = await game.actors.importFromCompendium(
      compendium,
      documentId,
      {
        folder: resolvedFolderId,
        ...(nameOverride ? { name: nameOverride } : {})
      }
    );
    if (!imported) throw new Error(`Failed to import "${documentId}" from "${pack}"`);

    return {
      id: imported.id,
      name: imported.name,
      type: imported.type,
      folder: resolvedFolderId,
      sourcePack: pack,
      sourceDocId: documentId
    };
  },

  /**
   * Create a world actor from scratch. System-agnostic — caller is expected
   * to supply system-correct `system` data (use `get_data_model` first to
   * learn the shape for the active system).
   */
  create_actor: async (params = {}) => {
    const { name, type, system, items, img, prototypeToken, folderId, folderName } = params;
    if (!name || !type) throw new Error("`name` and `type` are required");

    const resolvedFolderId = await _resolveFolder("Actor", folderId, folderName, true);

    const createData = { name, type, folder: resolvedFolderId };
    if (system) createData.system = system;
    if (img) createData.img = img;
    if (prototypeToken) createData.prototypeToken = prototypeToken;
    if (Array.isArray(items) && items.length) {
      createData.items = await Promise.all(items.map(_resolveItemRef));
    }

    const created = await Actor.create(createData);
    if (!created) throw new Error("Actor.create returned no document");

    return {
      id: created.id,
      name: created.name,
      type: created.type,
      folder: resolvedFolderId,
      itemIds: created.items.contents.map(i => i.id)
    };
  },

  /**
   * Add items to an existing actor. Items may be compendium refs
   * (`{ pack, documentId, nameOverride? }`) or inline definitions
   * (`{ name, type, system?, ... }`).
   */
  add_items_to_actor: async (params = {}) => {
    const { actorId, items } = params;
    if (!actorId) throw new Error("`actorId` is required");
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error("`items` must be a non-empty array");
    }

    const actor = game.actors.get(actorId);
    if (!actor) throw new Error(`Actor "${actorId}" not found`);

    const resolved = await Promise.all(items.map(_resolveItemRef));
    const created = await actor.createEmbeddedDocuments("Item", resolved);

    return {
      actorId,
      added: created.map((doc, i) => ({
        id: doc.id,
        name: doc.name,
        source: items[i].pack
          ? `${items[i].pack}/${items[i].documentId}`
          : "inline"
      }))
    };
  },

  /**
   * Create a journal entry with one or more pages. Pages default to type
   * "text" with HTML format; specify `text.format: 2` for Markdown.
   */
  create_journal_entry: async (params = {}) => {
    const { name, pages, folderId, folderName } = params;
    if (!name) throw new Error("`name` is required");
    if (!Array.isArray(pages) || pages.length === 0) {
      throw new Error("`pages` must be a non-empty array");
    }

    const resolvedFolderId = await _resolveFolder("JournalEntry", folderId, folderName, true);

    const normalizedPages = pages.map((p, i) => {
      if (!p?.name) throw new Error(`pages[${i}].name is required`);
      const pageData = { name: p.name, type: p.type ?? "text" };
      if (pageData.type === "text") {
        pageData.text = {
          content: p.text?.content ?? "",
          format:  p.text?.format  ?? 1
        };
      } else if (p.src) {
        pageData.src = p.src;
      }
      return pageData;
    });

    const created = await JournalEntry.create({
      name,
      folder: resolvedFolderId,
      pages: normalizedPages
    });
    if (!created) throw new Error("JournalEntry.create returned no document");

    return {
      id: created.id,
      name: created.name,
      folder: resolvedFolderId,
      pageIds: created.pages.contents.map(p => p.id)
    };
  },

  /**
   * Update a journal page's name and/or text content. Use `content` to
   * replace the body wholesale; use `appendContent` to add to the existing
   * body without losing it. At least one of name/content/appendContent
   * must be provided.
   */
  update_journal_page: async (params = {}) => {
    const { journalId, pageId, name, content, appendContent } = params;
    if (!journalId || !pageId) throw new Error("`journalId` and `pageId` are required");

    const journal = game.journal.get(journalId);
    if (!journal) throw new Error(`Journal "${journalId}" not found`);

    const page = journal.pages.get(pageId);
    if (!page) throw new Error(`Page "${pageId}" not found in journal "${journalId}"`);

    const updateData = {};
    const fieldsUpdated = [];

    if (typeof name === "string") {
      updateData.name = name;
      fieldsUpdated.push("name");
    }
    if (typeof content === "string") {
      updateData["text.content"] = content;
      fieldsUpdated.push("text.content (replaced)");
    } else if (typeof appendContent === "string") {
      const current = page.text?.content ?? "";
      updateData["text.content"] = current + appendContent;
      fieldsUpdated.push("text.content (appended)");
    }

    if (fieldsUpdated.length === 0) {
      throw new Error("Provide at least one of: `name`, `content`, `appendContent`");
    }

    await page.update(updateData);
    return { journalId, pageId, fieldsUpdated };
  },

  // -------------------------------------------------------------------------
  // World authoring — delete/update counterparts (also gated server-side
  // behind FOUNDRY_MCP_ALLOW_WRITE=1). These are the symmetric undo/edit
  // tools so an LLM can correct its own mistakes without escalating to
  // `evaluate`.
  // -------------------------------------------------------------------------

  /** Delete a folder by id. Foundry orphans contained documents (sets their
   *  folder to null) rather than cascading by default — use `deleteContents`
   *  to wipe the contents along with the folder. */
  delete_folder: async (params = {}) => {
    const { folderId, deleteContents } = params;
    if (!folderId) throw new Error("`folderId` is required");
    const folder = game.folders.get(folderId);
    if (!folder) throw new Error(`Folder "${folderId}" not found`);
    const meta = { id: folder.id, name: folder.name, type: folder.type };
    await folder.delete({ deleteSubfolders: !!deleteContents, deleteContents: !!deleteContents });
    return { ...meta, deleted: true, deleteContents: !!deleteContents };
  },

  /** Delete an actor by id. Permanent — Foundry's undo doesn't cover document
   *  deletion. The LLM should `get_actor` first if any data needs to be
   *  preserved. */
  delete_actor: async (params = {}) => {
    const { actorId } = params;
    if (!actorId) throw new Error("`actorId` is required");
    const actor = game.actors.get(actorId);
    if (!actor) throw new Error(`Actor "${actorId}" not found`);
    const meta = { id: actor.id, name: actor.name, type: actor.type };
    await actor.delete();
    return { ...meta, deleted: true };
  },

  /** Patch an existing actor's top-level fields and/or system data. Use this
   *  to tweak HP/stats/name/img after `create_actor_from_compendium` instead
   *  of recreating the actor from scratch. */
  update_actor: async (params = {}) => {
    const { actorId, name, img, system, prototypeToken } = params;
    if (!actorId) throw new Error("`actorId` is required");
    const actor = game.actors.get(actorId);
    if (!actor) throw new Error(`Actor "${actorId}" not found`);

    const updateData = {};
    const fieldsUpdated = [];
    if (typeof name === "string")        { updateData.name = name;                       fieldsUpdated.push("name"); }
    if (typeof img === "string")         { updateData.img = img;                         fieldsUpdated.push("img"); }
    if (system && typeof system === "object")
                                         { updateData.system = system;                   fieldsUpdated.push("system"); }
    if (prototypeToken && typeof prototypeToken === "object")
                                         { updateData.prototypeToken = prototypeToken;   fieldsUpdated.push("prototypeToken"); }

    if (fieldsUpdated.length === 0) {
      throw new Error("Provide at least one of: `name`, `img`, `system`, `prototypeToken`");
    }

    await actor.update(updateData);
    return { actorId, fieldsUpdated };
  },

  /** Remove embedded items from an actor by id. Items not found on the actor
   *  are reported in `missing`; the rest are deleted. */
  delete_items_from_actor: async (params = {}) => {
    const { actorId, itemIds } = params;
    if (!actorId) throw new Error("`actorId` is required");
    if (!Array.isArray(itemIds) || itemIds.length === 0) {
      throw new Error("`itemIds` must be a non-empty array");
    }
    const actor = game.actors.get(actorId);
    if (!actor) throw new Error(`Actor "${actorId}" not found`);

    const present = itemIds.filter(id => actor.items.get(id));
    const missing = itemIds.filter(id => !actor.items.get(id));

    if (present.length === 0) {
      return { actorId, deleted: [], missing };
    }

    const deletedSnapshot = present.map(id => {
      const it = actor.items.get(id);
      return { id, name: it.name, type: it.type };
    });
    await actor.deleteEmbeddedDocuments("Item", present);
    return { actorId, deleted: deletedSnapshot, missing };
  },

  /** Patch a single embedded item on an actor. `data` is merged into the
   *  item's document (top-level fields like `name`/`img`/`system.*`). */
  update_item_on_actor: async (params = {}) => {
    const { actorId, itemId, data } = params;
    if (!actorId || !itemId) throw new Error("`actorId` and `itemId` are required");
    if (!data || typeof data !== "object") {
      throw new Error("`data` must be an object with fields to update");
    }
    const actor = game.actors.get(actorId);
    if (!actor) throw new Error(`Actor "${actorId}" not found`);
    const item = actor.items.get(itemId);
    if (!item) throw new Error(`Item "${itemId}" not found on actor "${actorId}"`);

    await actor.updateEmbeddedDocuments("Item", [{ _id: itemId, ...data }]);
    return { actorId, itemId, fieldsUpdated: Object.keys(data) };
  },

  /** Delete a journal entry by id. Removes all pages with it. */
  delete_journal_entry: async (params = {}) => {
    const { journalId } = params;
    if (!journalId) throw new Error("`journalId` is required");
    const journal = game.journal.get(journalId);
    if (!journal) throw new Error(`Journal "${journalId}" not found`);
    const meta = { id: journal.id, name: journal.name, pageCount: journal.pages.size };
    await journal.delete();
    return { ...meta, deleted: true };
  },

  /** Delete a single page from a journal entry, leaving the entry itself. */
  delete_journal_page: async (params = {}) => {
    const { journalId, pageId } = params;
    if (!journalId || !pageId) throw new Error("`journalId` and `pageId` are required");
    const journal = game.journal.get(journalId);
    if (!journal) throw new Error(`Journal "${journalId}" not found`);
    const page = journal.pages.get(pageId);
    if (!page) throw new Error(`Page "${pageId}" not found in journal "${journalId}"`);
    const meta = { journalId, pageId, name: page.name };
    await journal.deleteEmbeddedDocuments("JournalEntryPage", [pageId]);
    return { ...meta, deleted: true };
  },

  /** Add a new page to an existing journal entry. Page shape matches
   *  `create_journal_entry`'s pages[] entries. Returns the new page id. */
  add_page_to_journal_entry: async (params = {}) => {
    const { journalId, page } = params;
    if (!journalId) throw new Error("`journalId` is required");
    if (!page?.name) throw new Error("`page.name` is required");
    const journal = game.journal.get(journalId);
    if (!journal) throw new Error(`Journal "${journalId}" not found`);

    const pageData = { name: page.name, type: page.type ?? "text" };
    if (pageData.type === "text") {
      pageData.text = {
        content: page.text?.content ?? "",
        format:  page.text?.format  ?? 1
      };
    } else if (page.src) {
      pageData.src = page.src;
    }

    const [created] = await journal.createEmbeddedDocuments("JournalEntryPage", [pageData]);
    if (!created) throw new Error("Journal page create returned no document");
    return { journalId, pageId: created.id, name: created.name };
  },

  // -------------------------------------------------------------------------
  // World authoring — scene placement & ownership (Tier B). Same write gate.
  // -------------------------------------------------------------------------

  /**
   * Place a new token for an actor onto a scene. Defaults to the active scene
   * when `sceneId` is omitted. Accepts coordinates as either x/y in pixels OR
   * gridX/gridY in cells (cell coords win if both provided).
   *
   * The new token starts from the actor's prototype token — name, image,
   * scale, vision, disposition, etc. all carry over. Override individual
   * fields via the optional params.
   */
  create_token: async (params = {}) => {
    const { actorId, sceneId, x, y, gridX, gridY, hidden, name, rotation } = params;
    if (!actorId) throw new Error("`actorId` is required");

    const actor = game.actors.get(actorId);
    if (!actor) throw new Error(`Actor "${actorId}" not found`);

    const scene = sceneId
      ? game.scenes.get(sceneId)
      : (game.scenes.active ?? canvas.scene);
    if (!scene) throw new Error(sceneId ? `Scene "${sceneId}" not found` : "No active scene to place token in");

    let finalX = x, finalY = y;
    if (gridX != null || gridY != null) {
      // v11+: scene.grid is a BaseGrid instance with .size; pre-v11: scene.grid is a number.
      const g = scene.grid;
      const gridSize = (g && typeof g === "object") ? g.size : g;
      if (!gridSize) throw new Error("Scene has no grid; pass x/y in pixels instead");
      finalX = (gridX ?? 0) * gridSize;
      finalY = (gridY ?? 0) * gridSize;
    }
    if (finalX == null || finalY == null) {
      throw new Error("Provide coordinates: either x+y (pixels) or gridX+gridY (cells)");
    }

    const protoDoc = await actor.getTokenDocument({ x: finalX, y: finalY });
    const tokenData = protoDoc.toObject();
    if (typeof hidden === "boolean")  tokenData.hidden   = hidden;
    if (typeof name === "string")     tokenData.name     = name;
    if (typeof rotation === "number") tokenData.rotation = rotation;

    const [created] = await scene.createEmbeddedDocuments("Token", [tokenData]);
    if (!created) throw new Error("Token create returned no document");
    return {
      id: created.id, sceneId: scene.id, actorId: actor.id,
      name: created.name, x: created.x, y: created.y, hidden: created.hidden
    };
  },

  /**
   * Set ownership levels on an actor. The `ownership` param is a map of
   * { user → level }. Keys can be:
   *   - "default"   → applies to every Foundry user not explicitly listed
   *   - a userId    → exact match against game.users
   *   - a userName  → resolved via case-sensitive exact match
   * Levels can be strings ("NONE"/"LIMITED"/"OBSERVER"/"OWNER"/"INHERIT") or
   * the corresponding integers (0/1/2/3/-1). The map is MERGED with existing
   * ownership — to clear a user's permission, set them to "NONE" explicitly.
   */
  set_actor_ownership: async (params = {}) => {
    const { actorId, ownership } = params;
    if (!actorId) throw new Error("`actorId` is required");
    if (!ownership || typeof ownership !== "object") {
      throw new Error("`ownership` is required and must be an object map of user → level");
    }
    const actor = game.actors.get(actorId);
    if (!actor) throw new Error(`Actor "${actorId}" not found`);

    const LEVELS = CONST.DOCUMENT_OWNERSHIP_LEVELS;
    const validNames = Object.keys(LEVELS);
    const resolveLevel = (v) => {
      if (typeof v === "number") return v;
      if (typeof v !== "string") throw new Error(`Invalid ownership level value: ${v}`);
      const upper = v.toUpperCase();
      if (upper in LEVELS) return LEVELS[upper];
      throw new Error(`Unknown ownership level "${v}". Use one of: ${validNames.join(", ")}`);
    };

    const newOwnership = { ...actor.ownership };
    const changed = [];
    for (const [key, val] of Object.entries(ownership)) {
      const level = resolveLevel(val);
      if (key === "default") {
        newOwnership.default = level;
        changed.push({ user: "default", level: val });
        continue;
      }
      let user = game.users.get(key) ?? game.users.find(u => u.name === key);
      if (!user) throw new Error(`User "${key}" not found (not a userId nor an exact userName)`);
      newOwnership[user.id] = level;
      changed.push({ userId: user.id, userName: user.name, level: val });
    }

    await actor.update({ ownership: newOwnership });
    return { actorId, actorName: actor.name, changed };
  },

  /**
   * Read the current ownership map of an actor, returning friendly level
   * names (NONE/LIMITED/OBSERVER/OWNER) and resolved user names.
   */
  get_actor_ownership: async (params = {}) => {
    const { actorId } = params;
    if (!actorId) throw new Error("`actorId` is required");
    const actor = game.actors.get(actorId);
    if (!actor) throw new Error(`Actor "${actorId}" not found`);

    const LEVELS = CONST.DOCUMENT_OWNERSHIP_LEVELS;
    const levelName = (v) => Object.keys(LEVELS).find(k => LEVELS[k] === v) ?? String(v);

    const users = [];
    for (const [key, val] of Object.entries(actor.ownership)) {
      if (key === "default") continue;
      const u = game.users.get(key);
      users.push({
        userId: key,
        userName: u?.name ?? "(unknown user)",
        role: u?.role,
        active: u?.active ?? false,
        level: levelName(val)
      });
    }

    return {
      actorId,
      actorName: actor.name,
      default: levelName(actor.ownership.default ?? 0),
      users
    };
  },

  // -------------------------------------------------------------------------
  // Combat tracking (Tier C). Reads work without ALLOW_WRITE; mutations
  // require it (gated server-side).
  // -------------------------------------------------------------------------

  /**
   * Get the state of the active combat encounter, or `{ active: false }`
   * when no combat is running.
   */
  get_combat: () => {
    const combat = game.combat;
    if (!combat) return { active: false };

    const cur = combat.combatant;
    return {
      active: true,
      id: combat.id,
      round: combat.round,
      turn: combat.turn,
      started: combat.started,
      sceneId: combat.scene?.id ?? null,
      currentCombatant: cur ? {
        id: cur.id,
        name: cur.name,
        tokenId: cur.tokenId,
        actorId: cur.actorId,
        initiative: cur.initiative
      } : null,
      combatants: combat.combatants.contents
        .slice()
        .sort((a, b) => (b.initiative ?? -Infinity) - (a.initiative ?? -Infinity))
        .map(c => ({
          id: c.id,
          name: c.name,
          tokenId: c.tokenId,
          actorId: c.actorId,
          initiative: c.initiative ?? null,
          hp: c.actor?.system?.attributes?.hp ?? c.actor?.system?.hp ?? null,
          defeated: c.defeated,
          hidden: c.hidden
        }))
    };
  },

  /**
   * Start a combat encounter. If no combat exists yet, one is created on the
   * current scene. `tokenIds` (optional) adds those tokens as combatants
   * before starting. `rollInitiative` can be "all", "npc", or false.
   */
  start_combat: async (params = {}) => {
    const { tokenIds, rollInitiative } = params;

    let combat = game.combat;
    if (combat?.started) {
      return { started: false, reason: "Combat already in progress", combatId: combat.id, round: combat.round };
    }

    if (!combat) {
      const sceneId = canvas.scene?.id ?? game.scenes.active?.id;
      if (!sceneId) throw new Error("No active scene to create combat on");
      combat = await Combat.create({ scene: sceneId });
      if (!combat) throw new Error("Failed to create combat encounter");
    }

    if (Array.isArray(tokenIds) && tokenIds.length) {
      const sceneId = combat.scene?.id;
      if (!sceneId) throw new Error("Combat has no scene to source tokens from");
      const combatantsData = tokenIds.map(id => ({ tokenId: id, sceneId }));
      await combat.createEmbeddedDocuments("Combatant", combatantsData);
    }

    if (rollInitiative === "all" || rollInitiative === true) {
      await combat.rollAll();
    } else if (rollInitiative === "npc") {
      await combat.rollNPC();
    }

    await combat.startCombat();
    return {
      started: true,
      combatId: combat.id,
      round: combat.round,
      combatantCount: combat.combatants.size,
      currentCombatantId: combat.combatant?.id ?? null
    };
  },

  /** End the active combat encounter (deletes it). */
  end_combat: async () => {
    const combat = game.combat;
    if (!combat) throw new Error("No active combat");
    const meta = { id: combat.id, round: combat.round, combatantCount: combat.combatants.size };
    await combat.delete();
    return { ...meta, ended: true };
  },

  /**
   * Advance the combat turn. `direction` defaults to "next"; pass "previous"
   * to step backward. Foundry handles round transitions automatically.
   */
  advance_combat: async (params = {}) => {
    const { direction = "next" } = params;
    const combat = game.combat;
    if (!combat) throw new Error("No active combat");
    if (!combat.started) throw new Error("Combat not started — call start_combat first");

    if (direction === "next")          await combat.nextTurn();
    else if (direction === "previous") await combat.previousTurn();
    else throw new Error(`Unknown direction "${direction}". Use "next" or "previous".`);

    const cur = combat.combatant;
    return {
      combatId: combat.id,
      round: combat.round,
      turn: combat.turn,
      currentCombatant: cur ? { id: cur.id, name: cur.name, initiative: cur.initiative } : null
    };
  },

  // -------------------------------------------------------------------------
  // Chat (Tier C). get_chat_messages is read-only; send_chat_message requires
  // ALLOW_WRITE (gated server-side).
  // -------------------------------------------------------------------------

  /**
   * Read chat history with filters. `limit` caps the returned messages
   * (most recent first by default — call returns them in chronological order).
   */
  get_chat_messages: (params = {}) => {
    const { limit = 50, since, speaker, includeRolls = true, includeWhispers = false } = params;

    let msgs = game.messages.contents;

    if (since) {
      const sinceMs = typeof since === "string" ? Date.parse(since) : since;
      if (!Number.isFinite(sinceMs)) throw new Error(`Invalid \`since\` value: ${since}`);
      msgs = msgs.filter(m => m.timestamp >= sinceMs);
    }
    if (speaker) {
      msgs = msgs.filter(m => m.speaker?.alias === speaker || m.speaker?.actor === speaker);
    }
    if (!includeRolls)    msgs = msgs.filter(m => !m.isRoll);
    if (!includeWhispers) msgs = msgs.filter(m => !m.whisper?.length);

    const slice = msgs.slice(-limit);
    return {
      total: msgs.length,
      returned: slice.length,
      messages: slice.map(m => ({
        id: m.id,
        timestamp: m.timestamp,
        time: new Date(m.timestamp).toISOString(),
        type: m.type,
        speaker: m.speaker,
        content: m.content,
        isRoll: m.isRoll,
        rolls: (m.rolls ?? []).map(r => ({ formula: r.formula, total: r.total, diceCount: r.dice?.length ?? 0 })),
        whisperTo: (m.whisper ?? []).map(uid => game.users.get(uid)?.name ?? uid)
      }))
    };
  },

  /**
   * Send a chat message. Speaker resolves from actorId/tokenId/alias, or
   * defaults to the current Foundry user (the routed user). `whisperTo`
   * accepts a userName or array of userNames.
   */
  send_chat_message: async (params = {}) => {
    const { content, speaker, actorId, tokenId, whisperTo, type } = params;
    if (!content) throw new Error("`content` is required");

    const data = { content };

    // ChatMessage style field renamed from `type` → `style` in Foundry v12+.
    // We're compat v12 minimum, so use `style` exclusively. CONST has both
    // CHAT_MESSAGE_STYLES (new, preferred) and CHAT_MESSAGE_TYPES (legacy alias)
    // — read either, write to data.style.
    const styleConsts = CONST.CHAT_MESSAGE_STYLES ?? CONST.CHAT_MESSAGE_TYPES;
    if (typeof type === "string") {
      const v = styleConsts?.[type.toUpperCase()];
      if (v !== undefined) data.style = v;
    } else if (typeof type === "number") {
      data.style = type;
    }

    // Speaker
    if (speaker || actorId || tokenId) {
      const sp = {};
      if (actorId) {
        const actor = game.actors.get(actorId);
        if (!actor) throw new Error(`Actor "${actorId}" not found`);
        sp.actor = actor.id;
        sp.alias = speaker ?? actor.name;
      }
      if (tokenId) {
        const scene = canvas.scene ?? game.scenes.active;
        const token = scene?.tokens.get(tokenId);
        if (!token) throw new Error(`Token "${tokenId}" not found on the active scene`);
        sp.token = token.id;
        sp.scene = scene.id;
      }
      if (typeof speaker === "string" && !sp.alias) sp.alias = speaker;
      data.speaker = sp;
    } else {
      data.speaker = ChatMessage.getSpeaker({ user: game.user });
    }

    // Whisper
    if (whisperTo) {
      const recipients = Array.isArray(whisperTo) ? whisperTo : [whisperTo];
      data.whisper = [];
      for (const rcpt of recipients) {
        const user = game.users.get(rcpt) ?? game.users.find(u => u.name === rcpt);
        if (!user) throw new Error(`User "${rcpt}" not found`);
        data.whisper.push(user.id);
      }
    }

    const msg = await ChatMessage.create(data);
    if (!msg) {
      throw new Error("ChatMessage.create returned no document — possible cause: invalid speaker/whisper/style field for this Foundry version");
    }
    return {
      id: msg.id,
      timestamp: msg.timestamp,
      speaker: msg.speaker,
      whisperedTo: (msg.whisper ?? []).map(uid => game.users.get(uid)?.name ?? uid),
      contentPreview: String(msg.content).slice(0, 80)
    };
  },

  // -------------------------------------------------------------------------
  // Roll requests (Tier C). Pops a dialog on the routed user's screen so
  // they can confirm and roll, then returns the result.
  // -------------------------------------------------------------------------

  /**
   * Pop a Dialog on the routed user's screen asking them to make a roll.
   * If `autoAccept: true`, skips the dialog and rolls immediately (useful
   * for GM-side automation or test scenarios).
   *
   * Server-side this tool is registered with a longer timeout window than
   * the standard 15s — see world-authoring.js registration.
   */
  request_roll: async (params = {}) => {
    const { formula, prompt = "The GM is requesting a roll.", timeoutSeconds = 60, label, autoAccept } = params;
    if (!formula || typeof formula !== "string") throw new Error("`formula` is required (e.g. '1d20+5')");

    // Auto-accept short-circuit: roll immediately, post to chat, return.
    if (autoAccept) {
      const roll = await new Roll(formula).evaluate();
      await roll.toMessage({ speaker: ChatMessage.getSpeaker(), flavor: label ?? prompt });
      return {
        mode: "auto_rolled",
        formula,
        total: roll.total,
        result: roll.result,
        dice: roll.dice.map(d => ({ faces: d.faces, results: d.results.map(x => x.result) }))
      };
    }

    const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

    return new Promise((resolve) => {
      let resolved = false;
      let dialog;

      const finalize = (result) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        try { dialog?.close(); } catch {}
        resolve(result);
      };

      const timer = setTimeout(() => finalize({ mode: "timed_out", formula }), timeoutSeconds * 1000);

      dialog = new Dialog({
        title: label ? `Roll Request: ${label}` : "Roll Request",
        content: `<div style="padding: 8px;">
            <p>${escapeHtml(prompt)}</p>
            <p><strong>Roll:</strong> <code>${escapeHtml(formula)}</code></p>
          </div>`,
        buttons: {
          roll: {
            label: "Roll",
            callback: async () => {
              try {
                const roll = await new Roll(formula).evaluate();
                await roll.toMessage({ speaker: ChatMessage.getSpeaker(), flavor: label ?? prompt });
                finalize({
                  mode: "rolled",
                  formula,
                  total: roll.total,
                  result: roll.result,
                  dice: roll.dice.map(d => ({ faces: d.faces, results: d.results.map(x => x.result) }))
                });
              } catch (err) {
                finalize({ mode: "error", formula, error: err.message });
              }
            }
          },
          cancel: {
            label: "Cancel",
            callback: () => finalize({ mode: "cancelled", formula })
          }
        },
        default: "roll",
        close: () => finalize({ mode: "dismissed", formula })
      });
      dialog.render(true);
    });
  },

  // -------------------------------------------------------------------------
  // Typed rolls + item use (v0.10.0). Same write gate.
  // -------------------------------------------------------------------------

  /**
   * Triggers a system-native roll (Skill, Ability, or Save) on an actor.
   * Normalises the result into a canonical MCP shape.
   */
  request_roll_typed: async (params = {}) => {
    const { actorId, type, identifier, dc, adv, fastForward = true } = params;
    if (!actorId || !type || !identifier) throw new Error("`actorId`, `type`, and `identifier` are required");

    const actor = game.actors.get(actorId) || game.actors.getName(actorId);
    if (!actor) throw new Error(`Actor "${actorId}" not found`);

    const systemId = game.system.id;
    const dispatcher = DISPATCHERS[systemId];
    if (!dispatcher) throw new Error(`System "${systemId}" not supported for typed rolls. Use request_roll.`);

    let result;
    if (type === "skill") result = await dispatcher.rollSkill(actor, { identifier, target: dc, adv });
    else if (type === "ability") result = await dispatcher.rollAbility(actor, { identifier, target: dc, adv });
    else if (type === "save") result = await dispatcher.rollSave(actor, { identifier, target: dc, adv });
    else throw new Error(`Unknown roll type "${type}". Use "skill", "ability", or "save".`);

    return _normalizeRollResult(systemId, result, actor, dc);
  },

  /**
   * Triggers only the attack roll part of an item's workflow.
   */
  request_attack_roll: async (params = {}) => {
    const { actorId, itemId, fastForward = true, adv } = params;
    if (!actorId || !itemId) throw new Error("`actorId` and `itemId` are required");

    const actor = game.actors.get(actorId) || game.actors.getName(actorId);
    if (!actor) throw new Error(`Actor "${actorId}" not found`);

    const item = actor.items.get(itemId) || actor.items.getName(itemId);
    if (!item) throw new Error(`Item "${itemId}" not found on actor "${actor.name}"`);

    const systemId = game.system.id;
    const dispatcher = DISPATCHERS[systemId];
    if (!dispatcher || !dispatcher.rollAttack) throw new Error(`System "${systemId}" not supported for attack rolls.`);

    const { roll } = await dispatcher.rollAttack(actor, item, { adv });
    
    // Try to get target AC from current targets
    let targetAC = null;
    const target = game.user.targets.first();
    if (target?.actor) {
      targetAC = target.actor.system.attributes?.ac?.value ?? target.actor.system.ac?.value;
    }

    return _normalizeAttackResult(systemId, roll, targetAC);
  },

  /**
   * Triggers the damage roll for an item without rolling an attack first.
   * Per-system damage context is resolved directly from the item — earlier
   * versions of this handler re-rolled the attack to fetch the dnd5e activity
   * which posted a duplicate chat card.
   */
  request_damage_roll: async (params = {}) => {
    const { actorId, itemId, isCritical } = params;
    if (!actorId || !itemId) throw new Error("`actorId` and `itemId` are required");

    const actor = game.actors.get(actorId) || game.actors.getName(actorId);
    if (!actor) throw new Error(`Actor "${actorId}" not found`);

    const item = actor.items.get(itemId) || actor.items.getName(itemId);
    if (!item) throw new Error(`Item "${itemId}" not found on actor "${actor.name}"`);

    const systemId = game.system.id;
    const dispatcher = DISPATCHERS[systemId];
    if (!dispatcher || !dispatcher.rollDamage) throw new Error(`System "${systemId}" not supported for damage rolls.`);

    let roll;
    if (systemId === "dnd5e") {
      const activity = item.system.activities?.find?.(a => a.type === "attack")
        ?? item.system.activities?.contents?.find(a => a.type === "attack");
      if (!activity) throw new Error(`No attack activity found on item "${item.name}"`);
      roll = await dispatcher.rollDamage(activity, { isCritical });
    } else if (systemId === "pf2e") {
      const strike = dispatcher.getStrike(actor, item.id);
      roll = await dispatcher.rollDamage(strike, { isCritical });
    } else if (systemId === "shadowdark") {
      // New shadowdark dispatcher needs item + crit flag (for the NPC-attack
      // direct-formula path) rather than the legacy itemUuid shape.
      roll = await dispatcher.rollDamage(actor, { item, isCritical });
    } else if (systemId === "vagabond") {
      roll = await dispatcher.rollDamage(item, { isCritical, actor });
    } else {
      throw new Error(`System "${systemId}" not supported for damage rolls.`);
    }

    return _normalizeDamageResult(systemId, roll, isCritical);
  },

  /**
   * Executes a full attack-and-damage workflow (v0.10.0 Full Flow).
   * Resolves a `targetAC` for the hit check from either `targetIds[0]` or the
   * current Foundry target, and threads the attack roll into the damage call
   * so per-system crit inheritance works.
   */
  request_item_use: async (params = {}) => {
    const { actorId, itemId, targetIds, activityId, adv } = params;
    if (!actorId || !itemId) throw new Error("`actorId` and `itemId` are required");

    const actor = game.actors.get(actorId) || game.actors.getName(actorId);
    if (!actor) throw new Error(`Actor "${actorId}" not found`);

    const item = actor.items.get(itemId) || actor.items.getName(itemId);
    if (!item) throw new Error(`Item "${itemId}" not found on actor "${actor.name}"`);

    const systemId = game.system.id;
    const dispatcher = DISPATCHERS[systemId];
    if (!dispatcher) throw new Error(`System "${systemId}" not supported for item use.`);

    // Resolve a target AC for hit-check (prefer first explicit targetId, else
    // current Foundry target). Non-d20 systems may not have AC at all.
    let targetAC = null;
    const firstTargetRef = Array.isArray(targetIds) && targetIds.length > 0 ? targetIds[0] : null;
    let primaryTarget = firstTargetRef
      ? (game.actors.get(firstTargetRef) || game.actors.getName(firstTargetRef) || canvas.tokens.get(firstTargetRef)?.actor)
      : game.user.targets.first()?.actor;
    if (primaryTarget) {
      targetAC = primaryTarget.system.attributes?.ac?.value ?? primaryTarget.system.ac?.value ?? null;
    }

    const results = { itemId: item.id };

    // 1. Attack
    const attackData = await dispatcher.rollAttack(actor, item, { activityId, adv });
    const rawAttackRoll = Array.isArray(attackData.roll) ? attackData.roll[0] : attackData.roll;
    results.attack = _normalizeAttackResult(systemId, attackData.roll, targetAC);

    // 2. Damage (if hit)
    if (results.attack.hit) {
      let damageRoll;
      const isCrit = results.attack.isCritical || results.attack.degreeOfSuccess === 3;

      if (systemId === "dnd5e") {
        // Thread the attack roll into damage so the activity inherits crit.
        damageRoll = await dispatcher.rollDamage(attackData.activity, { isCritical: isCrit, attackRoll: rawAttackRoll });
      } else if (systemId === "pf2e") {
        damageRoll = await dispatcher.rollDamage(attackData.strike, { isCritical: isCrit });
      } else if (systemId === "shadowdark") {
        damageRoll = await dispatcher.rollDamage(actor, { item, isCritical: isCrit, isNpc: attackData.isNpc });
      } else if (systemId === "vagabond") {
        damageRoll = await dispatcher.rollDamage(item, { isCritical: isCrit, actor });
      }

      results.damage = _normalizeDamageResult(systemId, damageRoll, isCrit);

      // 3. Apply (if targetIds provided)
      if (Array.isArray(targetIds) && targetIds.length > 0) {
        results.applied = [];
        for (const tid of targetIds) {
          const tactor = game.actors.get(tid) || game.actors.getName(tid) || canvas.tokens.get(tid)?.actor;
          if (!tactor) continue;
          const hpBefore = tactor.system.attributes?.hp?.value ?? tactor.system.hp?.value ?? null;
          const applyRes = await dispatcher.applyDamage(tactor, { amount: results.damage.total });
          const hpAfter  = tactor.system.attributes?.hp?.value ?? tactor.system.hp?.value ?? null;
          const computedDelta = (hpBefore != null && hpAfter != null) ? (hpBefore - hpAfter) : null;
          results.applied.push({
            targetId: tid,
            delta: applyRes?.delta ?? computedDelta ?? results.damage.total,
            newHP: applyRes?.newHP ?? hpAfter
          });
        }
      }
    }

    return results;
  },

  /**
   * Applies damage to one or more targets with mixed outcomes (AoE support).
   * Captures actor HP before and after each apply so `delta` reflects the
   * actual reduction (after IWR/resistance/temp HP), not the requested amount.
   */
  apply_damage: async (params = {}) => {
    const { damages } = params;
    if (!Array.isArray(damages)) throw new Error("`damages` must be an array of per-target damage objects");

    const systemId = game.system.id;
    const dispatcher = DISPATCHERS[systemId];
    if (!dispatcher || !dispatcher.applyDamage) throw new Error(`System "${systemId}" does not support apply_damage.`);

    const readHP = (a) => a.system.attributes?.hp?.value ?? a.system.hp?.value ?? a.system.health?.value ?? null;

    const appliedResults = [];
    for (const d of damages) {
      const { targetId, amount, type, multiplier = 1 } = d;
      const actor = game.actors.get(targetId) || game.actors.getName(targetId) || canvas.tokens.get(targetId)?.actor;
      if (!actor) {
        console.warn(`apply_damage: Target "${targetId}" not found`);
        appliedResults.push({ targetId, error: "target not found" });
        continue;
      }

      const hpBefore = readHP(actor);
      const res = await dispatcher.applyDamage(actor, { amount, type, multiplier });
      const hpAfter  = readHP(actor);
      const computedDelta = (hpBefore != null && hpAfter != null) ? (hpBefore - hpAfter) : null;

      appliedResults.push({
        targetId,
        delta:           res?.delta ?? computedDelta ?? (amount * multiplier),
        newHP:           res?.newHP ?? hpAfter,
        finalMultiplier: multiplier
      });
    }

    return { applied: appliedResults };
  },

  // -------------------------------------------------------------------------
  // v0.11: Scene placeables, settings, actor-item focus, template placement.
  // Reads aren't gated; place_measured_template is server-side gated behind
  // ALLOW_WRITE.
  // -------------------------------------------------------------------------

  /**
   * Return scene placeables of a given type. `get_scene` only returns Token
   * data; this exposes the other embedded collections so the LLM can inspect
   * templates, regions, walls, lights, drawings, and notes without an
   * evaluate.
   */
  get_scene_placeables: (params = {}) => {
    const { type = "Token", sceneId } = params;
    const scene = sceneId ? game.scenes.get(sceneId) : game.scenes.active;
    if (!scene) throw new Error(sceneId ? `Scene "${sceneId}" not found` : "No active scene");

    // Map of accepted type → embedded-collection name on the Scene document.
    const COLLECTIONS = {
      Token:            "tokens",
      MeasuredTemplate: "templates",
      Region:           "regions",
      Wall:             "walls",
      AmbientLight:     "lights",
      AmbientSound:     "sounds",
      Drawing:          "drawings",
      Note:             "notes",
      Tile:             "tiles"
    };
    const key = COLLECTIONS[type];
    if (!key) throw new Error(`Unsupported placeable type "${type}". Allowed: ${Object.keys(COLLECTIONS).join(", ")}`);

    const collection = scene[key];
    if (!collection) return { sceneId: scene.id, type, count: 0, items: [] };

    const items = collection.contents.map(doc => doc.toObject());
    return { sceneId: scene.id, sceneName: scene.name, type, count: items.length, items };
  },

  /**
   * Read Foundry settings. With `moduleId` only → returns all registered
   * settings for that module with their current values. With `moduleId` +
   * `key` → returns just that one. With no args → returns a list of every
   * registered (module, key) pair without values (catalog mode).
   */
  get_settings: (params = {}) => {
    const { moduleId, key } = params;

    // Catalog mode: list every registered setting.
    if (!moduleId) {
      const catalog = [];
      for (const setting of game.settings.settings.values()) {
        catalog.push({
          namespace: setting.namespace,
          key:       setting.key,
          scope:     setting.scope,
          type:      setting.type?.name ?? String(setting.type),
          isMenu:    !!setting.menu
        });
      }
      return { mode: "catalog", count: catalog.length, settings: catalog };
    }

    // Single-key mode.
    if (key) {
      try {
        const value = game.settings.get(moduleId, key);
        return { mode: "single", namespace: moduleId, key, value };
      } catch (err) {
        throw new Error(`Setting "${moduleId}.${key}" not registered or threw: ${err.message}`);
      }
    }

    // Module-scoped mode: every setting whose namespace matches moduleId.
    const matches = [];
    for (const setting of game.settings.settings.values()) {
      if (setting.namespace !== moduleId) continue;
      let value;
      try { value = game.settings.get(setting.namespace, setting.key); }
      catch { value = "(error reading)"; }
      matches.push({
        namespace: setting.namespace,
        key:       setting.key,
        scope:     setting.scope,
        value
      });
    }
    return { mode: "module", namespace: moduleId, count: matches.length, settings: matches };
  },

  /**
   * Focused list of an actor's embedded items. `get_actor` returns the full
   * actor document (~60KB on D&D characters). This returns just the items
   * with the fields most useful for picking one — name, id, type, img,
   * system data summary — and supports filtering by item type.
   */
  get_actor_items: (params = {}) => {
    const { actorId, type } = params;
    if (!actorId) throw new Error("`actorId` is required");

    const actor = game.actors.get(actorId) || game.actors.getName(actorId);
    if (!actor) throw new Error(`Actor "${actorId}" not found`);

    let items = actor.items.contents;
    if (type) items = items.filter(it => it.type === type);

    return {
      actorId,
      actorName: actor.name,
      filter: type ?? null,
      count: items.length,
      items: items.map(it => ({
        id:     it.id,
        name:   it.name,
        type:   it.type,
        img:    it.img,
        // System data tends to be the most relevant for picking an item;
        // keep it but skip the document-level cruft.
        system: it.system
      }))
    };
  },

  /**
   * Drop a MeasuredTemplate onto a scene (default: active scene). Used for
   * fireball-style area effects, walls of fire, etc. The bridge doesn't
   * trigger any "preview/place" UX — the template appears immediately at
   * the given coordinates with the configured fields.
   */
  place_measured_template: async (params = {}) => {
    const {
      type = "circle",        // "circle" | "cone" | "rect" | "ray"
      x, y,
      distance,               // grid distance (units)
      direction,              // degrees, for cone/ray
      angle,                  // degrees, for cone width
      width,                  // for ray
      fillColor,              // hex string
      texture,                // image path
      flags,                  // module flags (merge-deep)
      sceneId,
      hidden = false
    } = params;

    if (x == null || y == null) throw new Error("`x` and `y` (pixel coordinates) are required");
    if (distance == null) throw new Error("`distance` (in grid units) is required");

    const scene = sceneId ? game.scenes.get(sceneId) : game.scenes.active;
    if (!scene) throw new Error(sceneId ? `Scene "${sceneId}" not found` : "No active scene");

    const validTypes = ["circle", "cone", "rect", "ray"];
    if (!validTypes.includes(type)) throw new Error(`Invalid type "${type}". Allowed: ${validTypes.join(", ")}`);

    const data = {
      t: type,
      user: game.user.id,
      x, y,
      distance,
      direction: direction ?? 0,
      angle:     angle ?? (type === "cone" ? 53 : 0),
      width:     width ?? 0,
      fillColor: fillColor ?? game.user.color ?? "#FF0000",
      hidden: !!hidden
    };
    if (texture) data.texture = texture;
    if (flags && typeof flags === "object") data.flags = flags;

    const [created] = await scene.createEmbeddedDocuments("MeasuredTemplate", [data]);
    if (!created) throw new Error("MeasuredTemplate.create returned no document");

    return {
      id: created.id,
      sceneId: scene.id,
      type: created.t,
      x: created.x,
      y: created.y,
      distance: created.distance,
      direction: created.direction,
      angle: created.angle,
      width: created.width,
      hidden: created.hidden
    };
  },

  /**
   * Return the levels collection on a scene as a flat array. Multi-level
   * scenes (Foundry v13+ native) expose `scene.levels` as a Map-like — each
   * level has `{id, name, elevation: {bottom, top}}`. Single-level scenes
   * return an empty levels array with a note.
   */
  get_scene_levels: (params = {}) => {
    const scene = params.sceneId ? game.scenes.get(params.sceneId) : (canvas.scene ?? game.scenes.active);
    if (!scene) throw new Error(params.sceneId ? `Scene "${params.sceneId}" not found` : "No active scene");

    const collection = scene.levels;
    const arr = collection?.contents
            ?? (typeof collection?.values === "function" ? [...collection.values()] : (Array.isArray(collection) ? collection : []));

    const activeLevelId = (canvas?.scene?.id === scene.id) ? (canvas.level?.id ?? null) : null;

    return {
      sceneId:       scene.id,
      sceneName:     scene.name,
      activeLevelId,
      count:         arr.length,
      levels:        arr.map(l => ({
        id:        l.id,
        name:      l.name,
        elevation: l.elevation ? { bottom: l.elevation.bottom, top: l.elevation.top } : null
      })),
      ...(arr.length === 0 ? { note: "Scene has no levels collection — single-level scene." } : {})
    };
  },

  /**
   * Switch the canvas's active level (which floor of a multi-level scene is
   * being viewed). Affects everything reading `canvas.level` — SDX dungeon
   * painter, Levels-style visibility, wall-height. Pass either `levelId` or
   * an `elevation` (picks the level whose elevation range contains it).
   *
   * If the target scene isn't currently active, activates it first.
   * Tries multiple Foundry APIs in order — version-defensive.
   */
  set_canvas_level: async (params = {}) => {
    const { sceneId, levelId, elevation } = params;
    if (!levelId && typeof elevation !== "number") {
      throw new Error("Provide either `levelId` or `elevation`");
    }

    const scene = sceneId ? game.scenes.get(sceneId) : (canvas.scene ?? game.scenes.active);
    if (!scene) throw new Error(sceneId ? `Scene "${sceneId}" not found` : "No active scene");

    // Resolve target level from the scene's level collection.
    const levelsArr = scene.levels?.contents
                  ?? (typeof scene.levels?.values === "function" ? [...scene.levels.values()] : []);
    if (levelsArr.length === 0) {
      throw new Error(`Scene "${scene.name}" has no levels (single-level scene — nothing to switch).`);
    }

    let level;
    if (levelId) {
      level = scene.levels?.get?.(levelId) ?? levelsArr.find(l => l.id === levelId);
    } else {
      level = levelsArr.find(l => {
        const b = Number(l.elevation?.bottom ?? -Infinity);
        const t = Number(l.elevation?.top ?? Infinity);
        return elevation >= b && elevation <= t;
      });
    }
    if (!level) {
      throw new Error(
        `No level matching ${levelId ? `id "${levelId}"` : `elevation ${elevation}`} on scene "${scene.name}". ` +
        `Available: ${levelsArr.map(l => `${l.name} (${l.elevation?.bottom}..${l.elevation?.top})`).join(", ")}`
      );
    }

    // Canonical v14 API: Scene.view({level: levelId}). Internally this sets
    // canvas._viewOptions and calls canvas.draw(scene) which honors the
    // level. canvas.level is a read-only getter — direct assignment throws.
    const before = canvas.level?.id ?? null;
    await scene.view({ level: level.id });
    const after = canvas.level?.id ?? null;

    return {
      sceneId:   scene.id,
      sceneName: scene.name,
      levelId:   level.id,
      levelName: level.name,
      elevation: level.elevation,
      before, after,
      switched: before !== after
    };
  },

  /**
   * Activate an existing scene by id or exact name. Used when you want to
   * switch to a different scene without recreating one. Returns the scene's
   * id, name, and active state.
   */
  activate_scene: async (params = {}) => {
    const { sceneId, sceneName } = params;
    if (!sceneId && !sceneName) throw new Error("Either `sceneId` or `sceneName` is required");
    const scene = sceneId
      ? game.scenes.get(sceneId)
      : game.scenes.getName(sceneName);
    if (!scene) throw new Error(`Scene ${sceneId ? `id "${sceneId}"` : `name "${sceneName}"`} not found`);
    await scene.activate();
    return { id: scene.id, name: scene.name, active: scene.active };
  },

  /**
   * List every scene in the world as a flat array of `{id, name, active, folder}`.
   * Useful for finding an id to feed into activate_scene / delete_scene
   * without resorting to evaluate.
   */
  list_scenes: () => {
    return {
      count: game.scenes.size,
      scenes: game.scenes.contents.map(s => ({
        id:     s.id,
        name:   s.name,
        active: s.active,
        folder: s.folder?.id ?? null
      }))
    };
  },

  /**
   * Create a new scene. `activate` defaults to true so the LLM doesn't need
   * a second call for the common "make it and look at it" workflow.
   */
  create_scene: async (params = {}) => {
    const data = {
      name: params.name ?? "New Scene",
      width:   params.width   ?? 4000,
      height:  params.height  ?? 3000,
      padding: params.padding ?? 0.25,
      grid: {
        type:  params.gridType  ?? CONST.GRID_TYPES.SQUARE,
        size:  params.gridSize  ?? 100,
        alpha: params.gridAlpha ?? 0.2,
      },
      backgroundColor: params.backgroundColor ?? "#1c1c1c",
    };
    if (params.background) data.background = { src: params.background };
    if (params.folderId)   data.folder     = params.folderId;

    const scene = await Scene.create(data);
    if (!scene) throw new Error("Scene.create returned null");
    if (params.activate !== false) await scene.activate();
    return {
      id: scene.id,
      name: scene.name,
      active: scene.active,
      width: scene.width,
      height: scene.height,
      folder: scene.folder?.id ?? null
    };
  },

  /**
   * Delete a scene by id. Refuses to delete the currently active scene
   * unless `force: true` — gives the LLM a chance to consider whether it
   * really meant to wipe the open canvas.
   */
  delete_scene: async (params = {}) => {
    const { sceneId, sceneName, force = false } = params;
    if (!sceneId && !sceneName) throw new Error("Either `sceneId` or `sceneName` is required");
    const scene = sceneId
      ? game.scenes.get(sceneId)
      : game.scenes.getName(sceneName);
    if (!scene) throw new Error(`Scene ${sceneId ? `id "${sceneId}"` : `name "${sceneName}"`} not found`);

    if (scene.active && !force) {
      throw new Error(
        `Scene "${scene.name}" (${scene.id}) is currently active. ` +
        `Pass force: true to delete it anyway.`
      );
    }

    const meta = { id: scene.id, name: scene.name, wasActive: scene.active };
    await scene.delete();
    return { ...meta, deleted: true };
  },

  /**
   * Call a function exposed on `game.modules.get(moduleId).api`. This is the
   * allowlist-style alternative to `evaluate` — only functions a module
   * deliberately puts on its `.api` surface are reachable, so the security
   * model is "module author chooses what's callable" rather than "LLM can
   * run arbitrary code."
   *
   * Use this instead of `evaluate` when a module exposes structured helpers
   * (e.g. shadowdark-extras' generateDungeon, mythic-gme-tools' fateQuestion).
   * Args are passed positionally; the return is JSON-serialised.
   */
  call_module_api: async (params = {}) => {
    const { moduleId, fn, args } = params;
    if (!moduleId || !fn) throw new Error("`moduleId` and `fn` are required");

    const mod = game.modules.get(moduleId);
    if (!mod) throw new Error(`Module "${moduleId}" not installed`);
    if (!mod.api) throw new Error(`Module "${moduleId}" has no .api surface — module author hasn't exposed callable functions`);

    const target = mod.api[fn];
    if (typeof target !== "function") {
      const available = Object.keys(mod.api).filter(k => typeof mod.api[k] === "function").sort();
      throw new Error(`${moduleId}.api.${fn} is not a function. Available: ${available.join(", ") || "(none)"}`);
    }

    const callArgs = Array.isArray(args) ? args : [];
    const raw = await target(...callArgs);
    // Foundry documents have a toObject(); other values are JSON-cloned for
    // serialisation safety. null/undefined pass through cleanly.
    let result;
    if (raw == null) result = null;
    else if (typeof raw?.toObject === "function") result = raw.toObject();
    else {
      try { result = JSON.parse(JSON.stringify(raw)); }
      catch { result = String(raw); }
    }
    return { moduleId, fn, result };
  }
};

// ---------------------------------------------------------------------------
// WebSocket connection management
// ---------------------------------------------------------------------------
let ws = null;
let reconnectTimer = null;

function connect() {
  if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return;

  ws = new WebSocket(WS_URL);

  ws.addEventListener("open", () => {
    console.log(`${MODULE_ID} | Connected to MCP server at ${WS_URL}`);
    ui.notifications?.info("MCP Bridge connected to Claude Desktop");

    // Identity handshake — server uses this to route targeted tool calls
    // to the right Foundry user. Server falls back to a legacy-GM
    // registration if this doesn't arrive within 500ms (backward compat
    // for older bridges that never sent a hello frame).
    // If the server runs with BRIDGE_TOKEN set, the user must store the
    // matching token in localStorage so we can echo it back here:
    //   localStorage.setItem("mcpBridgeToken", "your-token")
    const helloFrame = {
      type:     "hello",
      userId:   game.user.id,
      userName: game.user.name,
      isGM:     game.user.isGM,
      // Origin host (e.g., "localhost:30000", "foundry.example.com").
      // Lets the server disambiguate two GMs with the same userName
      // by exposing routing keys like "Gamemaster@foundry.example.com".
      host:     (typeof window !== "undefined" && window.location?.host) || "",
    };
    try {
      const t = localStorage.getItem("mcpBridgeToken");
      if (t) helloFrame.token = t;
    } catch { /* ignore */ }
    ws.send(JSON.stringify(helloFrame));
  });

  ws.addEventListener("message", async (event) => {
    let request;
    try {
      request = JSON.parse(event.data);
    } catch {
      return;
    }

    const { id, tool, params } = request;
    const handler = handlers[tool];

    if (!handler) {
      ws.send(JSON.stringify({ id, error: `Unknown tool: ${tool}` }));
      return;
    }

    try {
      const data = await handler(params ?? {});
      ws.send(JSON.stringify({ id, data }));
    } catch (err) {
      console.error(`${MODULE_ID} | Handler error for ${tool}:`, err);
      ws.send(JSON.stringify({ id, error: err.message }));
    }
  });

  ws.addEventListener("close", () => {
    console.log(`${MODULE_ID} | Disconnected from MCP server, retrying in ${RECONNECT_DELAY / 1000}s...`);
    scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    // Will trigger close event — reconnect handled there
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_DELAY);
}

// ---------------------------------------------------------------------------
// Foundry hook — connect once the game is ready
// ---------------------------------------------------------------------------
Hooks.once("ready", () => {
  console.log(`${MODULE_ID} | Game ready — connecting to MCP server...`);
  connect();
});

// Expose for debugging from Foundry console
globalThis.mcpBridge = {
  get ws() { return ws; },
  get handlers() { return handlers; },
  reconnect: connect,
  get errors() { return errorBuffer; }
};
