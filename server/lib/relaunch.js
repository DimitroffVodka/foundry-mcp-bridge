/**
 * Shared, configured relaunch handler — a SINGLE instance used by both the
 * on-demand `relaunch_client` tool and the autonomous relaunch supervisor.
 *
 * Sharing one handler matters: the handler holds `managedBrowser`/`inFlight`
 * state, so two separate instances could each spawn a Chrome and fight over the
 * same profile. One instance => one managed browser, single-flight.
 */
import { createRelaunchHandler } from "./client-relauncher.js";
import { bridges, lastSeenBridges } from "./bridges.js";
import { RELAUNCH_CONFIG, FOUNDRY_URLS } from "./config.js";
import { diagnoseBridgeStatus } from "./bridge-status.js";

export const relaunchClient = createRelaunchHandler({
  config: RELAUNCH_CONFIG,
  bridges,
  diagnose: () => diagnoseBridgeStatus({
    bridges,
    lastSeenBridges,
    configuredOrigins: FOUNDRY_URLS,
  }),
});
