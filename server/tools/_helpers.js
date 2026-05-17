/**
 * Shared helpers used across the tools/ modules.
 *
 *   - `TARGET_USER_DESC` — single source of truth for the targetUser
 *     describer string. Used by both `registerRoutedTool` (which auto-
 *     injects targetUser into schemas) and any Type-B tool that builds
 *     its schema manually.
 *
 *   - `registerRoutedTool(mcp, name, desc, schema, bridgeTool?)` — the
 *     standard registration helper for tools that proxy directly to the
 *     Foundry bridge. Auto-injects targetUser into the schema and
 *     forwards via `callFoundry`. Hot-reload-aware: re-calling with the
 *     same name updates the existing tool (description, schema, handler)
 *     in place rather than throwing.
 *
 *   - `registerRawTool(mcp, name, desc, schema, callback)` — for Type-B
 *     tools that build their own schema (image returns, server-local
 *     orchestration). Same upsert semantics. Pass the schema with
 *     `targetUser` already on it if the tool needs routing.
 */
import { z }                                from "zod";
import { callFoundry }                      from "../lib/foundry-rpc.js";
import { upsertTool, noteTrackedTool }      from "../lib/hot-reload.js";

export const TARGET_USER_DESC =
  'Foundry user to route this call to. Omit (or pass "GM" / "self") '
  + 'to target the GM (default). Pass a player\'s exact user name to '
  + 'run as that player. Use list_connected_bridges to see who is '
  + 'currently connected.';

/**
 * Register a tool that proxies to the Foundry-side bridge handler with
 * automatic `targetUser` routing. Adds `targetUser?: string` to the
 * tool's schema so the MCP client can target a specific user; the
 * default route is the GM.
 *
 * @param {McpServer} mcp        per-session MCP server instance
 * @param {string}    name       MCP tool name (and bridge-side handler name)
 * @param {string}    desc       tool description shown to the LLM
 * @param {object}    schema     zod schema map for the tool's params
 *                               (without targetUser — added automatically)
 * @param {string}    [bridgeTool=name]  bridge-side tool name to proxy to
 */
export function registerRoutedTool(mcp, name, desc, schema, bridgeTool = name) {
  const augmentedSchema = {
    ...schema,
    targetUser: z.string().optional().describe(TARGET_USER_DESC),
  };
  noteTrackedTool(mcp, name);
  return upsertTool(mcp, name, desc, augmentedSchema, async (params) => {
    const { targetUser, ...toolParams } = params;
    return callFoundry(bridgeTool, toolParams, targetUser);
  });
}

/**
 * Register a Type-B tool — builds its own schema (and may inject
 * targetUser via TARGET_USER_DESC manually) and provides its own
 * callback. Used for image-returning tools and server-local tools.
 */
export function registerRawTool(mcp, name, desc, schema, callback) {
  noteTrackedTool(mcp, name);
  return upsertTool(mcp, name, desc, schema, callback);
}
