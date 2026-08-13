import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_BRIDGE_PORT,
  isLocalNetworkHost,
  normalizeBridgeUrl,
  resolveBridgeUrl,
} from "../../module/scripts/bridge-url.js";

// Freezes the address the module dials. This was a hardcoded
// "ws://localhost:3001", which meant a second device on the LAN could never
// connect — its "localhost" is itself, not the machine running the MCP server.
// The subtle half is the public-origin case: a hosted Foundry does NOT run the
// user's MCP server, so mirroring location.hostname there would break the
// working setup rather than fix anything.

test("a local Foundry keeps dialing localhost", () => {
  assert.equal(
    resolveBridgeUrl({ hostname: "localhost" }),
    `ws://localhost:${DEFAULT_BRIDGE_PORT}`
  );
});

test("a LAN Foundry dials the Foundry host, not the viewing device", () => {
  assert.equal(
    resolveBridgeUrl({ hostname: "192.168.0.106" }),
    `ws://192.168.0.106:${DEFAULT_BRIDGE_PORT}`
  );
});

test("a hosted Foundry falls back to localhost — it isn't running the MCP server", () => {
  assert.equal(
    resolveBridgeUrl({ hostname: "shadowfoundry.online" }),
    `ws://localhost:${DEFAULT_BRIDGE_PORT}`
  );
});

test("an explicit setting always wins, including over a public origin", () => {
  assert.equal(
    resolveBridgeUrl({ configured: "10.0.0.5", hostname: "shadowfoundry.online" }),
    `ws://10.0.0.5:${DEFAULT_BRIDGE_PORT}`
  );
});

test("a hostname-less caller degrades to localhost rather than an empty URL", () => {
  assert.equal(resolveBridgeUrl(), `ws://localhost:${DEFAULT_BRIDGE_PORT}`);
  assert.equal(resolveBridgeUrl({ hostname: "" }), `ws://localhost:${DEFAULT_BRIDGE_PORT}`);
});

test("an unparseable setting is ignored, not handed to WebSocket", () => {
  // Must fall back to the derived default — `new WebSocket("ws://not a host")`
  // throws synchronously and would take the whole connect() call down.
  assert.equal(normalizeBridgeUrl("not a host"), "");
  assert.equal(
    resolveBridgeUrl({ configured: "not a host", hostname: "localhost" }),
    `ws://localhost:${DEFAULT_BRIDGE_PORT}`
  );
});

test("the setting accepts what a person would actually type", () => {
  const cases = [
    ["192.168.0.106",             `ws://192.168.0.106:${DEFAULT_BRIDGE_PORT}`],
    ["192.168.0.106:3001",        "ws://192.168.0.106:3001"],
    ["192.168.0.106:9999",        "ws://192.168.0.106:9999"],
    ["ws://192.168.0.106:3001",   "ws://192.168.0.106:3001"],
    ["  192.168.0.106  ",         `ws://192.168.0.106:${DEFAULT_BRIDGE_PORT}`],
  ];
  for (const [input, expected] of cases) {
    assert.equal(normalizeBridgeUrl(input), expected, `input: ${JSON.stringify(input)}`);
  }
});

test("a wss:// URL keeps the TLS default port, not the bridge port", () => {
  // A page served over https cannot open ws:// to a private IP — mixed content
  // blocks it — so the only route for a remote device is a TLS proxy (Tailscale
  // Serve, a tunnel, nginx). Those listen on 443. Appending 3001 would produce
  // an address nothing answers on, and the failure looks like a dead bridge.
  assert.equal(normalizeBridgeUrl("wss://box.tailnet.ts.net"), "wss://box.tailnet.ts.net");
  assert.equal(normalizeBridgeUrl("wss://tunnel.example.com"), "wss://tunnel.example.com");
});

test("an explicit port is respected on either scheme", () => {
  assert.equal(normalizeBridgeUrl("wss://box.ts.net:8443"), "wss://box.ts.net:8443");
  assert.equal(normalizeBridgeUrl("ws://box.ts.net:9000"), "ws://box.ts.net:9000");
});

test("blank means auto, not a malformed URL", () => {
  assert.equal(normalizeBridgeUrl(""), "");
  assert.equal(normalizeBridgeUrl("   "), "");
  assert.equal(normalizeBridgeUrl(null), "");
  assert.equal(normalizeBridgeUrl(undefined), "");
});

test("private and loopback ranges are recognised", () => {
  for (const h of [
    "localhost", "127.0.0.1", "127.1.2.3", "::1", "[::1]",
    "10.0.0.5", "192.168.1.1", "172.16.0.1", "172.31.255.255",
    "169.254.1.1", "foundry.local", "box.lan", "host.internal",
    "fd00::1", "fe80::1",
  ]) {
    assert.equal(isLocalNetworkHost(h), true, `expected local: ${h}`);
  }
});

test("public hosts and near-miss ranges are not treated as local", () => {
  // 172.15/172.32 sit just outside RFC1918 — a sloppy /^172\./ would swallow
  // them and send a public-origin client at an address that can't answer.
  for (const h of [
    "shadowfoundry.online", "example.com", "8.8.8.8",
    "172.15.0.1", "172.32.0.1", "11.0.0.1", "192.169.0.1", "",
  ]) {
    assert.equal(isLocalNetworkHost(h), false, `expected public: ${h}`);
  }
});
