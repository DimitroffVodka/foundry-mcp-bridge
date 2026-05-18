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
}
