import test from "node:test";
import assert from "node:assert/strict";

import { createRelaunchSupervisor } from "../lib/relaunch-supervisor.js";

const validConfig = {
  enabled: true,
  auto: true,
  foundryUrl: "http://localhost:30000",
  gmUser: "Bridge",
  gmPassword: "",
  chromePath: "/usr/bin/chromium",
  userDataDir: "",
  allowRemote: false,
  headless: true,
  autoIntervalMs: 15_000,
  autoMaxBackoffMs: 300_000,
};

const gmBridge = {
  userId: "bridge-id",
  userName: "Bridge",
  origin: "http://localhost:30000",
  isGM: true,
};

test("supervisor does not schedule a timer when auto is disabled", () => {
  let scheduled = 0;
  const sup = createRelaunchSupervisor({
    config: { ...validConfig, auto: false },
    bridges: new Map(),
    relaunch: async () => ({ ready: true }),
    setIntervalFn: () => { scheduled += 1; return { unref() {} }; },
  });
  sup.start();
  assert.equal(scheduled, 0);
});

test("supervisor with auto=1 but invalid config does not schedule", () => {
  let scheduled = 0;
  const sup = createRelaunchSupervisor({
    config: { ...validConfig, chromePath: "" }, // invalid → validateRelaunchConfig fails
    bridges: new Map(),
    relaunch: async () => ({ ready: true }),
    setIntervalFn: () => { scheduled += 1; return { unref() {} }; },
  });
  sup.start();
  assert.equal(scheduled, 0);
});

test("supervisor relaunches when the configured GM bridge is absent", async () => {
  let calls = 0;
  const sup = createRelaunchSupervisor({
    config: validConfig,
    bridges: new Map(),
    relaunch: async () => { calls += 1; return { ready: true, alreadyConnected: false }; },
    now: () => 1000,
  });
  await sup.tick();
  assert.equal(calls, 1);
});

test("supervisor stays idle when the configured GM bridge is connected", async () => {
  let calls = 0;
  const sup = createRelaunchSupervisor({
    config: validConfig,
    bridges: new Map([["bridge-id", gmBridge]]),
    relaunch: async () => { calls += 1; return { ready: true }; },
    now: () => 1000,
  });
  await sup.tick();
  assert.equal(calls, 0);
});

test("supervisor backs off after a failed relaunch and skips during cooldown", async () => {
  let calls = 0;
  let clock = 1000;
  const sup = createRelaunchSupervisor({
    config: validConfig,
    bridges: new Map(),
    relaunch: async () => { calls += 1; return { ready: false, error: "foundry down" }; },
    now: () => clock,
  });

  await sup.tick();                 // attempt 1 → fails, backoff = 30s (nextAttemptAt = 31000)
  assert.equal(calls, 1);

  await sup.tick();                 // clock still 1000 → within cooldown → skipped
  assert.equal(calls, 1);

  clock = 1000 + 31_000;            // advance past the backoff window
  await sup.tick();                 // attempt 2
  assert.equal(calls, 2);
});

test("supervisor resets backoff once the GM reconnects", async () => {
  let calls = 0;
  let clock = 1000;
  const bridges = new Map();
  const sup = createRelaunchSupervisor({
    config: validConfig,
    bridges,
    relaunch: async () => { calls += 1; return { ready: false }; },
    now: () => clock,
  });

  await sup.tick();                 // fails → backoff set
  assert.equal(calls, 1);
  bridges.set("bridge-id", gmBridge); // GM comes back (e.g. user reopened their tab)
  await sup.tick();                 // present → resets backoff, no relaunch
  assert.equal(calls, 1);
  assert.equal(sup._state().backoffMs, 0);
});
