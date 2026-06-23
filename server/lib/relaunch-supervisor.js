/**
 * Autonomous relaunch supervisor.
 *
 * The on-demand `relaunch_client` tool can recover a crashed GM tab, but only
 * when something *calls* it. This supervisor calls it for you: it polls for the
 * configured GM bridge and, when it's absent, invokes the (idempotent, single-
 * flight) relaunch handler — with exponential backoff so a down Foundry doesn't
 * trigger a Chrome-launch storm.
 *
 * It is a thin loop over the SAME shared handler the tool uses, so the two can
 * never double-launch. Opt-in via FOUNDRY_RELAUNCH_AUTO=1 (also needs a valid
 * relaunch config, i.e. FOUNDRY_RELAUNCH_ENABLED=1 + URL/GM/Chrome).
 */
import { validateRelaunchConfig } from "./client-relauncher.js";

export function createRelaunchSupervisor({
  config,
  bridges,
  relaunch,
  logger = () => {},
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  now = () => Date.now(),
}) {
  let timer = null;
  let running = false;     // a relaunch is in flight this tick
  let backoffMs = 0;
  let nextAttemptAt = 0;

  function gmPresent() {
    for (const b of bridges.values()) {
      if (b?.isGM && b.userName === config.gmUser) return true;
    }
    return false;
  }

  function bumpBackoff() {
    const base = config.autoIntervalMs ?? 15_000;
    const cap = config.autoMaxBackoffMs ?? 300_000;
    backoffMs = Math.min(cap, (backoffMs || base) * 2);
    nextAttemptAt = now() + backoffMs;
    return backoffMs;
  }

  async function tick() {
    if (running) return;
    const validation = validateRelaunchConfig(config);
    if (!validation.valid) return; // misconfigured — stay silent, nothing to do

    if (gmPresent()) { backoffMs = 0; nextAttemptAt = 0; return; }
    if (now() < nextAttemptAt) return; // cooling down after a failed attempt

    running = true;
    try {
      logger(`[relaunch-supervisor] GM "${config.gmUser}" not connected — relaunching client`);
      const result = await relaunch();
      if (result?.ready) {
        backoffMs = 0;
        nextAttemptAt = 0;
        logger(`[relaunch-supervisor] client ${result.alreadyConnected ? "already connected" : "recovered"}`);
      } else {
        const waited = bumpBackoff();
        logger(`[relaunch-supervisor] relaunch not ready (${result?.error ?? "unknown"}); backing off ${Math.round(waited / 1000)}s`);
      }
    } catch (error) {
      const waited = bumpBackoff();
      logger(`[relaunch-supervisor] relaunch threw: ${error?.message ?? error}; backing off ${Math.round(waited / 1000)}s`);
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (timer) return;
      if (!config.auto) {
        logger("[relaunch-supervisor] disabled (set FOUNDRY_RELAUNCH_AUTO=1 to enable)");
        return;
      }
      const validation = validateRelaunchConfig(config);
      if (!validation.valid) {
        logger(`[relaunch-supervisor] FOUNDRY_RELAUNCH_AUTO=1 but config is invalid: ${validation.errors.join("; ")}`);
        return;
      }
      const interval = config.autoIntervalMs ?? 15_000;
      timer = setIntervalFn(() => { tick().catch(() => {}); }, interval);
      // Don't keep the event loop alive solely for this heartbeat.
      if (timer && typeof timer.unref === "function") timer.unref();
      logger(`[relaunch-supervisor] watching GM "${config.gmUser}" every ${Math.round(interval / 1000)}s`);
    },
    stop() {
      if (timer) { clearIntervalFn(timer); timer = null; }
    },
    // exposed for tests
    tick,
    _state: () => ({ backoffMs, nextAttemptAt, running }),
  };
}
