import test from "node:test";
import assert from "node:assert/strict";

import { SERVER_INSTRUCTIONS } from "../lib/server-instructions.js";

// The instructions are injected into every MCP client's context at connect, so
// they're the one channel that reaches a pure MCP client (which never sees
// AGENTS.md/TOOLS.md). Guard that they exist, stay cheap, and keep the
// tool-selection policy — the thing that stops agents defaulting to evaluate.

test("instructions exist and stay within a sane per-session context budget", () => {
  assert.equal(typeof SERVER_INSTRUCTIONS, "string");
  assert.ok(SERVER_INSTRUCTIONS.trim().length > 0, "instructions must not be empty");
  assert.ok(
    SERVER_INSTRUCTIONS.length < 4000,
    `instructions are ${SERVER_INSTRUCTIONS.length} chars — trim to keep per-session context cost low`
  );
});

test("instructions carry the prefer-dedicated-over-evaluate policy", () => {
  const s = SERVER_INSTRUCTIONS;
  assert.match(s, /evaluate/i);
  assert.match(s, /dedicated/i);
  assert.match(s, /last[- ]resort/i);
  // names concrete dedicated tools so the model learns they exist
  assert.ok(
    /apply_damage|move_token|actor_write/.test(s),
    "instructions should name concrete dedicated tools"
  );
});

test("instructions cover routing and the read-only/no-resources gotchas", () => {
  const s = SERVER_INSTRUCTIONS;
  assert.match(s, /targetUser/);
  assert.match(s, /resources/i); // "everything is a tool; no resources/prompts"
});
