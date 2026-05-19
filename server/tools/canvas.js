/**
 * Canvas + token tools.
 *
 * Two flavors here:
 *   - Standard routed tools (scene query, token CRUD, conditions, target)
 *     use `registerRoutedTool` — text-content replies via `callFoundry`.
 *   - Image-returning tools (`screenshot`, `screenshot_dom`, `capture_scene`)
 *     are Type B: they bypass `registerRoutedTool` because they need
 *     `callFoundryImage` to wrap the reply as an MCP image content block.
 *     For Type B tools we manually inject `targetUser` into the schema.
 */
import { z }                                from "zod";
import { registerRoutedTool, registerRawTool, TARGET_USER_DESC, AUDIT_DESC } from "./_helpers.js";
import { callFoundryImage }                 from "../lib/foundry-rpc.js";

export function registerCanvasTools(mcp) {
  // --- Scene + token query ---
  registerRoutedTool(mcp, "get_scene",
    "Get the active scene: dimensions, grid settings, and all tokens with positions.",
    {});

  registerRoutedTool(mcp, "get_selected_token",
    "Get the currently selected token on the canvas and its actor data.",
    {});

  registerRoutedTool(mcp, "get_token_details",
    "Get full details for a single token: position, size, rotation, hidden state, disposition, " +
    "linked actor data, and active status conditions.",
    { token: z.string().describe("Token id, token name, or linked actor name on the active scene.") });

  // --- Token mutation ---
  registerRoutedTool(mcp, "move_token",
    "Move a token to (x, y) on the active scene. Optionally disable animation for instant placement.",
    {
      token:   z.string().describe("Token id, token name, or linked actor name."),
      x:       z.number().describe("Target x coordinate (scene pixels)."),
      y:       z.number().describe("Target y coordinate (scene pixels)."),
      animate: z.boolean().optional().describe("Animate movement. Default true."),
      audit:   z.boolean().optional().describe(AUDIT_DESC),
    });

  registerRoutedTool(mcp, "move_token_pathed",
    "Move a token to (x, y) using A* pathfinding against scene walls on the active scene. " +
    "Falls back to a plain teleport if no polygon backend is available. Set canOpenDoors=true " +
    "to have the token open closed doors along the path (their wall ids are returned in doorsOpened). " +
    "Only the final waypoint animates; intermediate hops teleport. Returns pathCost when pathfinding runs.",
    {
      token:        z.string().describe("Token id, token name, or linked actor name."),
      x:            z.number().describe("Target x coordinate (scene pixels)."),
      y:            z.number().describe("Target y coordinate (scene pixels)."),
      animate:      z.boolean().optional().describe("Animate the final hop. Default true."),
      canOpenDoors: z.boolean().optional().describe("Open closed doors along the path. Default false."),
      elevation:    z.number().optional().describe("Applied to the final waypoint."),
      rotation:     z.number().optional().describe("Applied to the final waypoint."),
      audit:        z.boolean().optional().describe("Return an audit block with before/after diffs and undo instructions."),
    });

  registerRoutedTool(mcp, "update_token",
    "Update token properties on the active scene. Allowed updates: x, y, width, height, rotation, " +
    "hidden, disposition, name, elevation, lockRotation, sort, alpha, tint.",
    {
      token:   z.string().describe("Token id, token name, or linked actor name."),
      updates: z.record(z.string(), z.any()).describe("Object of fields to update (whitelisted keys only)."),
      audit:   z.boolean().optional().describe(AUDIT_DESC),
    });

  registerRoutedTool(mcp, "delete_tokens",
    "Delete one or more tokens from the active scene.",
    {
      tokens: z.array(z.string()).describe("Token ids, names, or linked actor names."),
      audit:  z.boolean().optional().describe(AUDIT_DESC),
    });

  // --- Conditions / targeting ---
  registerRoutedTool(mcp, "toggle_token_condition",
    "Toggle a status effect / condition on a token's linked actor. Use `get_available_conditions` " +
    "to see valid condition ids for the current system.",
    {
      token:     z.string().describe("Token id, token name, or linked actor name."),
      condition: z.string().describe("Condition id (e.g. 'prone', 'poisoned')."),
      active:    z.boolean().optional().describe("Force on (true) or off (false). Omit to toggle."),
      audit:     z.boolean().optional().describe(AUDIT_DESC),
    });

  registerRoutedTool(mcp, "get_available_conditions",
    "List all status conditions registered in the current system (id, label, icon).",
    {});

  registerRoutedTool(mcp, "target",
    "Set the current user's targets to the named tokens on the active scene. " +
    "Equivalent to hovering each token and pressing T. Pass an empty array to clear. " +
    "Call this before `click`-ing an attack so the system computes hits against real defenses.",
    {
      tokens: z.array(z.string()).describe("Token names, actor names, or token document ids on the current scene. Empty array clears targets."),
      audit:  z.boolean().optional().describe(AUDIT_DESC),
    });

  // --- Multi-level scene (v0.11.2) ---
  registerRoutedTool(mcp, "get_scene_levels",
    "Return the levels collection on a multi-level scene (Foundry v14 native, " +
    "not present on v12/v13) as a flat array of `{id, name, elevation: {bottom, top}}`. " +
    "Empty array for single-level scenes or pre-v14 worlds. Includes the " +
    "currently-active `levelId` when the scene is the viewed one.",
    {
      sceneId: z.string().optional().describe("Target scene id. Default: active scene."),
    });

  registerRoutedTool(mcp, "set_canvas_level",
    "Switch the canvas's active level — which floor of a multi-level scene " +
    "is being viewed. Affects anything reading `canvas.level` (shadowdark-" +
    "extras dungeon painter, level-aware visibility, wall-height, etc). " +
    "Pass `levelId` OR an `elevation` (picks the level whose range contains " +
    "it). Activates the target scene first if it isn't currently active.",
    {
      sceneId:   z.string().optional().describe("Target scene id. Default: active scene."),
      levelId:   z.string().optional().describe("Level document id (preferred — unambiguous)."),
      elevation: z.number().optional().describe("Elevation in Foundry units; picks the level whose [bottom, top] contains it."),
    });

  // --- Image-returning tools (Type B: manual targetUser injection) ---
  registerRawTool(mcp, "screenshot",
    "Capture the live Foundry PIXI game canvas (map + tokens) as an image. " +
    "Downscaled JPEG by default to keep payloads small. Does NOT capture " +
    "DOM overlays like sheets or HUD elements — only the game canvas itself.",
    {
      scale:   z.number().optional().describe("Resize factor (0.1–1.0). Default 0.5."),
      quality: z.number().optional().describe("JPEG quality (0.1–1.0). Default 0.7. Ignored for PNG."),
      format:  z.enum(["jpeg", "png"]).optional().describe("Output format. Default 'jpeg'."),
      targetUser: z.string().optional().describe(TARGET_USER_DESC),
    },
    async (p) => {
      const { targetUser, ...toolParams } = p;
      return callFoundryImage("screenshot", toolParams,
        d => `Canvas screenshot — ${d.width}×${d.height} ${d.mimeType}`, targetUser);
    });

  registerRawTool(mcp, "screenshot_dom",
    "Screenshot a DOM element (character sheets, HUD, chat cards, app windows) via html2canvas. " +
    "Fills the gap that `screenshot` can't — `screenshot` is PIXI-only and never captures DOM. " +
    "Pass a CSS selector; defaults to `body`. Good for UI/layout comparison and sheet debugging. " +
    "html2canvas is loaded lazily from a CDN on first use.",
    {
      selector: z.string().optional().describe("CSS selector of the element to capture. Default: 'body'."),
      scale:    z.number().optional().describe("Resize factor (0.1–1.0). Default 0.75."),
      quality:  z.number().optional().describe("JPEG quality (0.1–1.0). Default 0.8. Ignored for PNG."),
      format:   z.enum(["png", "jpeg"]).optional().describe("Output format. Default 'png' (better for UI)."),
      targetUser: z.string().optional().describe(TARGET_USER_DESC),
    },
    async (p) => {
      const { targetUser, ...toolParams } = p;
      return callFoundryImage("screenshot_dom", toolParams,
        d => `DOM screenshot of \`${d.selector}\` (${d.element.tag}${d.element.id ? "#"+d.element.id : ""}) — ${d.width}×${d.height} ${d.mimeType}`,
        targetUser);
    });

  registerRawTool(mcp, "capture_scene",
    "Capture the active scene canvas as a base64 WebP with a coordinate grid overlay (gx,gy labels " +
    "per cell). Useful for spatial reasoning — lets the model see which grid cell each token sits in. " +
    "Distinct from `screenshot`, which is a plain JPEG with no overlay.",
    {
      targetUser: z.string().optional().describe(TARGET_USER_DESC),
    },
    async (p) => {
      const { targetUser } = p;
      return callFoundryImage("capture_scene", {},
        d => `Scene "${d.sceneName}" [${d.sceneId}] — ${d.width}×${d.height} ${d.mimeType} with grid overlay`,
        targetUser);
    });
}
