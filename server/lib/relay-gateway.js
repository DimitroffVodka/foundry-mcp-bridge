/**
 * Relay gateway — Node side.
 *
 * Owns a managed Chromium page joined to Foundry as an ordinary client, and
 * uses it to reach browsers the MCP server cannot talk to directly. See the
 * gateway-relay-plan artifact for why this exists at all.
 *
 * Two decisions are load-bearing and easy to undo by accident:
 *
 * 1. The page is driven over CDP (`page.evaluate`), NOT by having the page open
 *    a WebSocket back to localhost. An in-page socket would put the gateway
 *    itself under Chrome's Local Network Access checks — the very restriction
 *    this design exists to escape. Node → CDP → page is local IPC and is not
 *    subject to any browser network policy.
 *
 * 2. The keys live HERE, never in the browser. The gateway page runs
 *    unattended for long periods; if it is compromised, the attacker gets a
 *    pipe, not the ability to sign requests or decrypt results. The page only
 *    ever broadcasts envelopes we signed and hands back sealed blobs we open.
 */

import { randomUUID } from "node:crypto";
import {
  generateGatewayKeys,
  signRequest,
  openFromClient,
} from "../../module/scripts/relay-crypto.js";
import { log } from "./log.js";

const DISCOVERY_SETTLE_MS = 1_500;

export function createRelayGateway({
  foundryUrl,
  gmUser,
  gmPassword = "",
  chromePath,
  userDataDir = "",
  headless = true,
  launchBrowser,
} = {}) {
  let browser = null;
  let page = null;
  let keys = null;
  let started = false;

  async function launch() {
    const puppeteer = await import("puppeteer-core");
    const launcher = launchBrowser ?? ((opts) => puppeteer.launch(opts));
    return launcher({
      headless,
      executablePath: chromePath,
      ...(userDataDir ? { userDataDir } : {}),
      args: [
        "--no-first-run",
        "--no-default-browser-check",
        // A headless gateway has no GPU; without this, software WebGL
        // (SwiftShader) pegs a core rendering a canvas nobody looks at.
        "--disable-gpu",
      ],
    });
  }

  /** Join the world as `gmUser`. The gateway must be GM-capable to publish keys. */
  async function joinWorld() {
    await page.goto(new URL("/join", foundryUrl).toString(), { waitUntil: "networkidle2" });

    const joined = await page.evaluate(async ({ user, pass }) => {
      const form = document.querySelector("form#join-game, form.join-form, form");
      if (!form) return { ok: false, reason: "no join form — already in a world?" };
      const select = form.querySelector('select[name="userid"], select[name="userId"]');
      if (select) {
        const opt = [...select.options].find((o) => o.textContent.trim() === user);
        if (!opt) return { ok: false, reason: `user "${user}" not offered on the join screen` };
        select.value = opt.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
      const pw = form.querySelector('input[name="password"]');
      if (pw) pw.value = pass;
      form.querySelector('button[name="join"], button[type="submit"]')?.click();
      return { ok: true };
    }, { user: gmUser, pass: gmPassword });

    if (!joined.ok) throw new Error(`Gateway could not join: ${joined.reason}`);

    await page.waitForFunction(() => globalThis.game?.ready === true, { timeout: 60_000 });
    await page.waitForFunction(() => !!globalThis.mcpRelay, { timeout: 30_000 });
  }

  return {
    get isRunning() { return started; },

    async start() {
      if (started) return;
      keys = await generateGatewayKeys();

      browser = await launch();
      page = await browser.newPage();
      page.on("console", (m) => {
        const t = m.text();
        if (t.includes("foundry-mcp-live")) log(`[gateway page] ${t}`);
      });

      await joinWorld();

      const published = await keys.publish();
      const identity = await page.evaluate(async (pub) => {
        const id = globalThis.mcpRelay.becomeGateway();
        await globalThis.mcpRelay.publishGatewayKeys(pub);
        return id;
      }, published);

      // Clients that booted before us answer the discover broadcast; give them
      // a moment to land before the first listClients() call.
      await new Promise((r) => setTimeout(r, DISCOVERY_SETTLE_MS));

      started = true;
      log(`Relay gateway ready as "${gmUser}" — clientId ${identity.clientId}`);
      return identity;
    },

    /** Browsers currently reachable through the relay. */
    async listClients() {
      if (!started) throw new Error("Relay gateway is not running.");
      return page.evaluate(() => globalThis.mcpRelay.listRelayClients());
    },

    /**
     * Run a tool in a specific remote browser.
     * Signed here, broadcast by the page, sealed reply opened here.
     */
    async request(targetClientId, tool, params = {}, timeoutMs = 20_000) {
      if (!started) throw new Error("Relay gateway is not running.");

      const envelope = await signRequest({
        v: 1,
        type: "request",
        requestId: randomUUID(),
        targetClientId,
        tool,
        params,
        nonce: randomUUID(),
        issuedAt: Date.now(),
      }, keys.signing.privateKey);

      const reply = await page.evaluate(
        (env, ms) => globalThis.mcpRelay.sendSignedRequest(env, ms),
        envelope, timeoutMs,
      );

      if (reply?.error) throw new Error(reply.error);
      if (!reply?.sealed) throw new Error("Relay reply carried no payload.");
      return openFromClient(reply.sealed, keys.sealing.privateKey);
    },

    async stop() {
      started = false;
      try { await browser?.close(); } catch { /* already gone */ }
      browser = null; page = null; keys = null;
    },
  };
}
