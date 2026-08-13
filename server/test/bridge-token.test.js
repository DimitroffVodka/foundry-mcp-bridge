import test from "node:test";
import assert from "node:assert/strict";

import { resolveBridgeToken } from "../../module/scripts/bridge-token.js";

// Freezes the precedence rule for the hello frame's token. The world setting
// must win: it is the only source a GM can correct for every client at once,
// so a stale hand-set localStorage value must never be able to keep a client
// locked out of a world whose token has since been fixed.

test("the world setting is used when set", () => {
  assert.equal(resolveBridgeToken({ worldSetting: "abc123" }), "abc123");
});

test("localStorage carries clients whose world has no setting", () => {
  assert.equal(resolveBridgeToken({ localValue: "legacy-token" }), "legacy-token");
});

test("the world setting beats a stale localStorage value", () => {
  assert.equal(
    resolveBridgeToken({ worldSetting: "current", localValue: "stale" }),
    "current"
  );
});

test("a blank world setting falls through instead of blanking the token", () => {
  // The common shape on an existing install: setting registered but never
  // filled in, token still in localStorage. Returning "" here would send no
  // token at all and get the client closed with 1008.
  assert.equal(resolveBridgeToken({ worldSetting: "", localValue: "from-storage" }), "from-storage");
  assert.equal(resolveBridgeToken({ worldSetting: "   ", localValue: "from-storage" }), "from-storage");
});

test("no token anywhere means send none", () => {
  assert.equal(resolveBridgeToken(), "");
  assert.equal(resolveBridgeToken({}), "");
  assert.equal(resolveBridgeToken({ worldSetting: "", localValue: "" }), "");
});

test("null/undefined sources are tolerated, not stringified", () => {
  // game.settings.get and localStorage.getItem both return null-ish on a miss;
  // "null" as a token would be sent and rejected.
  assert.equal(resolveBridgeToken({ worldSetting: null, localValue: null }), "");
  assert.equal(resolveBridgeToken({ worldSetting: undefined, localValue: "x" }), "x");
});

test("surrounding whitespace from a paste is trimmed", () => {
  assert.equal(resolveBridgeToken({ worldSetting: "  abc123  " }), "abc123");
  assert.equal(resolveBridgeToken({ localValue: "\tabc123\n" }), "abc123");
});
