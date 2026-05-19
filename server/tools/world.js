/**
 * World-state read-only proxy tools — game info, actors, items, modules,
 * compendiums, journals, tables, macros, system data model.
 *
 * All tools here proxy 1:1 to bridge-side handlers; each is a thin schema
 * + description wrapper.
 */
import { z }                  from "zod";
import { registerRoutedTool } from "./_helpers.js";

export function registerWorldTools(mcp) {
  // --- Game info ---
  registerRoutedTool(mcp, "get_game_info",
    "Get basic info about the running Foundry VTT instance: game system, world, version, connected users.",
    {});

  // --- Actors ---
  registerRoutedTool(mcp, "list_actors",
    "List all actors in the world. Optionally filter by type or folder name.",
    {
      type:   z.string().optional().describe("Filter by actor type (e.g. 'character', 'npc')"),
      folder: z.string().optional().describe("Filter by folder name"),
    });

  registerRoutedTool(mcp, "get_actor",
    "Get full actor data by id or name.",
    {
      id:   z.string().optional().describe("Actor document ID"),
      name: z.string().optional().describe("Actor name (exact match)"),
    });

  registerRoutedTool(mcp, "get_active_effects",
    "Get all Active Effects on a given actor by id or name.",
    {
      id:   z.string().optional().describe("Actor document ID"),
      name: z.string().optional().describe("Actor name"),
    });

  // --- Modules ---
  registerRoutedTool(mcp, "list_modules",
    "List installed Foundry modules. By default shows only active modules.",
    { activeOnly: z.boolean().optional().describe("Include inactive modules if false. Default: true") });

  // --- Compendiums ---
  registerRoutedTool(mcp, "list_compendiums",
    "List all compendium packs with metadata (label, document type, entry count).",
    { type: z.string().optional().describe("Filter by document type (e.g. 'Actor', 'Item')") });

  registerRoutedTool(mcp, "search_compendium",
    "Search a compendium pack by text query.",
    {
      pack:  z.string().describe("Pack ID (e.g. 'vagabond.monsters')"),
      query: z.string().optional().describe("Text to search for in entry names"),
      full:  z.boolean().optional().describe("Return full documents if true (max 20)"),
    });

  registerRoutedTool(mcp, "get_compendium_document",
    "Get a specific document from a compendium pack by id or name.",
    {
      pack: z.string().describe("Pack ID"),
      id:   z.string().optional().describe("Document ID within the pack"),
      name: z.string().optional().describe("Document name (case-insensitive)"),
    });

  // --- Items ---
  registerRoutedTool(mcp, "list_items",
    "List world-level items. Optionally filter by type.",
    { type: z.string().optional().describe("Filter by item type") });

  registerRoutedTool(mcp, "get_item",
    "Get full item data by id or name.",
    {
      id:   z.string().optional().describe("Item document ID"),
      name: z.string().optional().describe("Item name (exact match)"),
    });

  // --- Data model ---
  registerRoutedTool(mcp, "get_data_model",
    "Get the system data model template for a document type.",
    {
      type:    z.string().optional().describe("'Actor' or 'Item'. Default: 'Actor'"),
      subtype: z.string().optional().describe("Sub-type (e.g. 'character', 'monster')"),
    });

  // --- Journals / Tables / Macros ---
  registerRoutedTool(mcp, "list_journals",
    "List journal entries. Optionally filter by folder.",
    { folder: z.string().optional().describe("Filter by folder name") });

  registerRoutedTool(mcp, "list_tables",
    "List all roll tables with their formulas and result counts.",
    {});

  registerRoutedTool(mcp, "list_macros",
    "List all macros. Shows first 200 chars of each command.",
    {});

  registerRoutedTool(mcp, "get_macro",
    "Get full macro data including complete command source.",
    {
      id:   z.string().optional().describe("Macro document ID"),
      name: z.string().optional().describe("Macro name (exact match)"),
    });

  // --- Combat tracker (read) ---
  registerRoutedTool(mcp, "get_combat",
    "Get the state of the active combat encounter — round, current turn, "
    + "and an initiative-sorted combatant list with HP/defeated/hidden flags. "
    + "Returns `{ active: false }` when no combat is running.",
    {});

  // --- Chat history (read) ---
  registerRoutedTool(mcp, "get_chat_messages",
    "Read chat history with filters. Returns most recent messages up to "
    + "`limit`, sorted chronologically. Includes resolved roll formulas and "
    + "totals when present.",
    {
      limit:           z.number().int().min(1).max(500).optional().describe("Max messages to return. Default 50."),
      since:           z.union([z.string(), z.number()]).optional().describe(
        "Only return messages from this point on. Accepts an ISO timestamp string or epoch ms."
      ),
      speaker:         z.string().optional().describe(
        "Filter by `speaker.alias` (commonly the actor name) or `speaker.actor` (actor id)."
      ),
      includeRolls:    z.boolean().optional().describe("Include roll messages. Default true."),
      includeWhispers: z.boolean().optional().describe("Include whispers. Default false."),
    });

  // --- Scene placeables (v0.11) ---
  registerRoutedTool(mcp, "get_scene_placeables",
    "List placeables of a given type on a scene. `get_scene` only returns "
    + "tokens; this exposes the other embedded collections — templates, "
    + "regions, walls, lights, sounds, drawings, notes, tiles — so the LLM "
    + "can inspect them without falling back to `evaluate`. Returns full "
    + "document data (via toObject()) for each item.",
    {
      type:    z.enum(["Token", "MeasuredTemplate", "Region", "Wall", "AmbientLight", "AmbientSound", "Drawing", "Note", "Tile"])
                .optional().describe("Document type. Default 'Token'."),
      sceneId: z.string().optional().describe("Target scene id. Default: active scene."),
      select:  z.array(z.string()).optional().describe(
        "Optional projection — array of dotted field paths to keep (e.g. "
        + "['_id', 'name', 'behaviors.type']). Drastically reduces payload size "
        + "when the caller only needs a few fields per item. Array paths map "
        + "across elements: 'behaviors.type' on a region returns the array of "
        + "each behavior's type."
      ),
    });

  // --- Settings (v0.11) ---
  registerRoutedTool(mcp, "get_settings",
    "Read Foundry settings. Three modes: "
    + "(1) No args → catalog of every registered (namespace, key) pair "
    + "without values. "
    + "(2) `moduleId` only → all settings for that namespace with current values. "
    + "(3) `moduleId` + `key` → just that one setting's value.",
    {
      moduleId: z.string().optional().describe("Module/system namespace (e.g. 'core', 'dnd5e', 'levels')."),
      key:      z.string().optional().describe("Specific setting key within the namespace."),
    });

  // --- Focused actor item list (v0.11) ---
  registerRoutedTool(mcp, "get_actor_items",
    "Focused list of an actor's embedded items, optionally filtered by item "
    + "type. Returns just `{id, name, type, img, system}` per item — much "
    + "smaller payload than `get_actor` when you only need to pick one item.",
    {
      actorId: z.string().describe("Actor document id or exact name."),
      type:    z.string().optional().describe("Filter by item type (e.g. 'weapon', 'spell', 'class')."),
    });

  // --- Region behavior type discovery (v0.12.0) ---
  registerRoutedTool(mcp, "list_region_behavior_types",
    "Enumerate every registered RegionBehavior subtype and its schema "
    + "fields. Lets the agent discover what `changeLevel`, `executeScript`, "
    + "`damageToken`, `defineSurface`, etc. accept without reading the "
    + "Foundry/system source. Returns `{ types: { <type>: { <field>: <DataField type>, ... } } }`.",
    {});

  // --- Module API call (v0.11.1) ---
  registerRoutedTool(mcp, "call_module_api",
    "Call a function exposed on `game.modules.get(moduleId).api`. Allowlist-"
    + "style alternative to `evaluate` — only functions a module deliberately "
    + "puts on its `.api` surface are reachable. The module author chooses "
    + "what's callable, so this avoids the arbitrary-code-execution surface "
    + "of evaluate while still letting agents drive third-party integrations "
    + "(shadowdark-extras dungeon generation, mythic-gme-tools fate questions, "
    + "etc.). Args are passed positionally; result is JSON-serialised.",
    {
      moduleId: z.string().describe("Module ID (e.g. 'shadowdark-extras', 'mythic-gme-tools')."),
      fn:       z.string().optional().describe(
        "Function name on `module.api`. **Omit to discover what's available** — "
        + "returns the full list without calling anything."
      ),
      args:     z.array(z.any()).optional().describe("Positional args. Default: []."),
    });
}
