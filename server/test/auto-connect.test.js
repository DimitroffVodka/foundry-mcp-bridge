import test from "node:test";
import assert from "node:assert/strict";

import { shouldAutoConnect } from "../../module/scripts/auto-connect.js";

// Freezes the truth table for the `ready`-hook branch that decides whether a
// client opens the MCP bridge socket on world load. This is the logic that
// silently broke before — a deployed client defaulted to NOT connecting, so no
// "connected" toast ever fired.

test("an opted-in interactive client connects", () => {
  assert.equal(shouldAutoConnect({ optedIn: true, headless: false }), true);
});

test("a play client that opted out stays silent", () => {
  assert.equal(shouldAutoConnect({ optedIn: false, headless: false }), false);
});

test("the headless bridge client always connects, even when opted out", () => {
  // The dedicated no-canvas client must keep the MCP tools available regardless
  // of any one GM toggling auto-connect off on their play client.
  assert.equal(shouldAutoConnect({ optedIn: false, headless: true }), true);
});

test("opted-in and headless both true still connects", () => {
  assert.equal(shouldAutoConnect({ optedIn: true, headless: true }), true);
});

test("missing/undefined settings default to not connecting (no accidental socket)", () => {
  assert.equal(shouldAutoConnect({}), false);
  assert.equal(shouldAutoConnect(), false);
  assert.equal(shouldAutoConnect({ optedIn: undefined, headless: undefined }), false);
});

test("non-boolean truthy/falsy setting values are coerced, not leaked", () => {
  // game.settings can hand back odd values; the helper must return a real boolean.
  assert.equal(shouldAutoConnect({ optedIn: 1, headless: 0 }), true);
  assert.equal(shouldAutoConnect({ optedIn: 0, headless: 0 }), false);
  assert.equal(shouldAutoConnect({ optedIn: null, headless: "yes" }), true);
});
