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

console.error = (...args) => {
  _origError.apply(console, args);
  errorBuffer.push({
    level: "error",
    message: args.map(a => (typeof a === "object" ? JSON.stringify(a, null, 2) : String(a))).join(" "),
    timestamp: Date.now()
  });
  if (errorBuffer.length > MAX_ERRORS) errorBuffer.shift();
};

console.warn = (...args) => {
  _origWarn.apply(console, args);
  errorBuffer.push({
    level: "warn",
    message: args.map(a => (typeof a === "object" ? JSON.stringify(a, null, 2) : String(a))).join(" "),
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

    // Fallback: grab the first actor/item of the requested sub-type and return its system data
    if (type === "Actor" || !params.subtype) {
      const sample = game.actors.contents[0];
      if (sample) return { _sampleFrom: sample.name, system: sample.toObject().system };
    }
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
    // Whitelist top-level keys to avoid accidental destructive writes
    const allowed = ["x", "y", "width", "height", "rotation", "hidden", "disposition", "name", "elevation", "lockRotation", "sort", "alpha", "tint"];
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
