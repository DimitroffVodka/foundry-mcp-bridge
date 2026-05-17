/**
 * World-authoring tools — create folders, actors, items, and journal entries
 * in the running Foundry world. These tools mutate persistent state and are
 * gated behind `FOUNDRY_MCP_ALLOW_WRITE=1` on the server. When the gate is
 * off, none of these tools are registered and they will not appear in any
 * MCP client's tool list — failing closed.
 *
 * All tools route through the standard `targetUser` mechanism, so the LLM
 * can scope authoring to a specific Foundry world when multiple bridges are
 * connected. The actual create/update calls run in the targeted user's
 * browser context with that user's permissions.
 */
import { z }                  from "zod";
import { registerRoutedTool } from "./_helpers.js";
import { ALLOW_WRITE }        from "../lib/config.js";

export function registerWorldAuthoringTools(mcp) {
  if (!ALLOW_WRITE) return;

  // --- Folders ---
  registerRoutedTool(mcp, "create_folder",
    "Create a folder in the Foundry sidebar. Idempotent — if a folder with "
    + "the same `type` + `name` + `parentFolder` already exists, returns it "
    + "instead of creating a duplicate (`existed: true` in the response). "
    + "Use this to organize actors/items/journals created by subsequent calls.",
    {
      type:         z.enum(["Actor", "Item", "JournalEntry", "Scene", "Macro", "Playlist", "RollTable", "Cards"])
                      .describe("Sidebar document type the folder will hold."),
      name:         z.string().describe("Folder name (case-sensitive)."),
      parentFolder: z.string().optional().describe(
        "Optional parent folder. Accepts a folder document id or an exact "
        + "name match within the same `type`."
      ),
      color:        z.string().optional().describe(
        "Optional hex color (e.g. '#3a5'). Foundry shows this on the folder header."
      ),
    });

  // --- Actor from compendium ---
  registerRoutedTool(mcp, "create_actor_from_compendium",
    "Import an actor from a compendium pack into the world. Use this when "
    + "the target creature is already statted (monster manuals, NPC libraries, "
    + "homebrew compendiums). Use `search_compendium` or "
    + "`get_compendium_document` first to find the document id.",
    {
      pack:         z.string().describe("Compendium pack id (e.g. 'dnd5e.monsters')."),
      documentId:   z.string().describe("Document id within the pack."),
      folderId:     z.string().optional().describe("Target folder document id (wins over folderName if both given)."),
      folderName:   z.string().optional().describe(
        "Target folder by exact name. Auto-created as an Actor folder if it doesn't exist."
      ),
      nameOverride: z.string().optional().describe("Rename the imported actor."),
    });

  // --- Actor from scratch ---
  registerRoutedTool(mcp, "create_actor",
    "Create a brand-new actor in the world from scratch. System-agnostic — "
    + "the `system` parameter is the system-specific data block and you should "
    + "call `get_data_model` first to learn its shape for the active system. "
    + "Use this for custom NPCs/monsters that aren't in any compendium. For "
    + "actors that ARE in a compendium, prefer `create_actor_from_compendium`.",
    {
      name:           z.string().describe("Actor name."),
      type:           z.string().describe(
        "Actor subtype, system-specific (e.g. 'character', 'npc' for dnd5e; "
        + "'Player' for shadowdark). Use `get_data_model({type: 'Actor'})` "
        + "to see valid types in the active system."
      ),
      system:         z.record(z.any()).optional().describe(
        "System-specific data block. Shape varies per game system. "
        + "Use `get_data_model({type: 'Actor', subtype: '<type>'})` to learn the structure."
      ),
      items:          z.array(z.record(z.any())).optional().describe(
        "Optional inline items to attach at creation. Each entry is either "
        + "{ pack, documentId, nameOverride? } (from a compendium) or "
        + "{ name, type, system, ... } (inline definition)."
      ),
      img:            z.string().optional().describe("Portrait image path/URL."),
      prototypeToken: z.record(z.any()).optional().describe(
        "Optional prototype token data (img, scale, disposition, etc.)."
      ),
      folderId:       z.string().optional().describe("Target folder id."),
      folderName:     z.string().optional().describe(
        "Target folder by exact name. Auto-created as an Actor folder if it doesn't exist."
      ),
    });

  // --- Add items to existing actor ---
  registerRoutedTool(mcp, "add_items_to_actor",
    "Add items (weapons, spells, gear, features — any embedded Item document) "
    + "to an existing actor. Items can be sourced from a compendium pack or "
    + "defined inline. Useful after `create_actor_from_compendium` for "
    + "customizing a base creature without altering the source pack.",
    {
      actorId: z.string().describe("Actor document id."),
      items:   z.array(z.record(z.any())).describe(
        "Items to add. Each entry is { pack, documentId, nameOverride? } "
        + "(compendium ref) OR { name, type, system?, ... } (inline)."
      ),
    });

  // --- Journal entry ---
  registerRoutedTool(mcp, "create_journal_entry",
    "Create a journal entry with one or more pages. Pages default to type "
    + "'text' with HTML format. Use this to build quest journals, session "
    + "notes, encounter writeups, etc. Page ids are returned so you can "
    + "iterate with `update_journal_page` later.",
    {
      name:       z.string().describe("Journal entry name (shown in the sidebar)."),
      pages:      z.array(z.object({
        name:   z.string().describe("Page name (shown in the entry's page list)."),
        type:   z.enum(["text", "image", "pdf", "video"]).optional().describe("Default 'text'."),
        text:   z.object({
          content: z.string().describe("Page body."),
          format:  z.union([z.literal(1), z.literal(2)]).optional().describe(
            "1 = HTML (default), 2 = Markdown."
          )
        }).optional(),
        src:    z.string().optional().describe("URL/path for image/pdf/video pages."),
      })).describe("At least one page."),
      folderId:   z.string().optional().describe("Target folder id."),
      folderName: z.string().optional().describe(
        "Target folder by exact name. Auto-created as a JournalEntry folder if missing."
      ),
    });

  // --- Update journal page ---
  registerRoutedTool(mcp, "update_journal_page",
    "Update a journal page's name and/or text content. Use `content` to "
    + "replace the body wholesale; use `appendContent` to add to the existing "
    + "body without losing it. Designed for iterative writing — first pass "
    + "creates a skeleton, follow-up calls append richer narrative.",
    {
      journalId:     z.string().describe("Parent journal entry id."),
      pageId:        z.string().describe("Page id within that journal."),
      name:          z.string().optional().describe("Replace the page name."),
      content:       z.string().optional().describe("Replace the page body (HTML or Markdown per the page's format)."),
      appendContent: z.string().optional().describe("Append to the existing page body. Ignored if `content` is also provided."),
    });
}
