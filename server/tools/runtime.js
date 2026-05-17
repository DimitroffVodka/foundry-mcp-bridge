/**
 * Runtime + DOM tools — `evaluate`, `click`, `simulate_dialog_response`,
 * `get_console_errors`. These act on the running Foundry runtime/DOM
 * rather than persisted data.
 */
import { z }                  from "zod";
import { registerRoutedTool } from "./_helpers.js";

export function registerRuntimeTools(mcp) {
  // --- Console errors ---
  registerRoutedTool(mcp, "get_console_errors",
    "Get recent console errors and warnings from the Foundry client. Invaluable for debugging. " +
    "Returns { bufferSize, bufferCapacity, returned, entries[] }. Buffer holds up to 1000 entries. " +
    "Defaults to the last 60 seconds of entries when sinceMs is omitted (was previously 'all', which was too noisy).",
    {
      count:   z.number().optional().describe("Number of recent entries. Default: all matching the time window (max 1000)"),
      sinceMs: z.number().optional().describe("Only entries from the last N ms. Default 60000 (last minute). Pass 0 to disable the filter."),
      level:   z.enum(["error", "warn"]).optional().describe("Filter by level."),
    });

  // --- Evaluate ---
  registerRoutedTool(mcp, "evaluate",
    "Evaluate arbitrary JavaScript in the live Foundry VTT context. "
    + "Has access to `game`, `canvas`, and `ui` globals. "
    + "Write the body of an async function; `return` to send data back; "
    + "`await` works.\n\n"
    + "Gotchas:\n"
    + "• Returns are JSON-stringified — Foundry document objects (Actor, "
    + "Item, ChatMessage, etc.) serialize as `{}`. Wrap them in `.toObject()` "
    + "or pull specific fields explicitly.\n"
    + "• Map / Set / DOM nodes / functions silently drop. Convert to plain "
    + "structures: `[...map.entries()]`, `[...set]`, `el.outerHTML`, etc.\n"
    + "• To inspect a tool/object surface, enumerate explicitly: "
    + "`Object.keys(obj).map(k => ({ k, t: typeof obj[k] }))`.\n"
    + "• Response includes `evalMs` so you can tell whether a slow call is "
    + "the bridge or your code.",
    {
      expression: z.string().describe(
        "JS to evaluate (body of an async function with game/canvas/ui in scope)."
      ),
    });

  // --- DOM interaction ---
  registerRoutedTool(mcp, "click",
    "Simulate a player clicking a DOM element — character sheet button, chat card action " +
    "button, or any visible app window button (including DialogV2 prompts if you can target the " +
    "dialog's selector). Use this for attack/damage/feature buttons that only work through the " +
    "sheet's real dispatch path. Combine with `rig` to force dice results. Captures any chat " +
    "messages created during the click. For DialogV2 dialogs without a stable selector, prefer " +
    "`simulate_dialog_response` which finds the topmost dialog and clicks by label/index.",
    {
      selector:  z.string().describe("CSS selector for the element to click, e.g. '[data-action=\"vce-bless-mode\"][data-mode=\"allies\"]', or 'dialog button.dialog-button[data-action=\"yes\"]'."),
      rig:       z.array(z.number()).optional().describe("Forced face values for dice rolled during the click."),
      openActor: z.string().optional().describe("If set, render this actor's sheet first so its buttons exist in the DOM."),
      waitMs:    z.number().optional().describe("Milliseconds to wait for async chat messages after the click. Default 400."),
    });

  registerRoutedTool(mcp, "simulate_dialog_response",
    "Click a button on the topmost open DialogV2 dialog. Use after a tool action " +
    "that opens a confirmation/options dialog (spell cast options, talent cast " +
    "config, alchemy cookbook prompts, the dialog-helpers `confirmDialog` / " +
    "`waitDialog` wrappers). Match by `label` (button text contains, case-insensitive) " +
    "or `index` (zero-based position in the dialog's button row). Returns the " +
    "dialog title and the clicked button's resolved label.",
    {
      label: z.string().optional().describe("Match the first button whose visible text contains this string (case-insensitive). Mutually exclusive with `index`."),
      index: z.number().optional().describe("Zero-based index of the button to click. Use when multiple buttons share text or label match is ambiguous."),
    });
}
