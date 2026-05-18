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
import { z }                                     from "zod";
import { registerRoutedTool, registerRawTool, TARGET_USER_DESC } from "./_helpers.js";
import { callFoundry }                           from "../lib/foundry-rpc.js";
import { ALLOW_WRITE }                           from "../lib/config.js";

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
      system:         z.record(z.string(), z.any()).optional().describe(
        "System-specific data block. Shape varies per game system. "
        + "Use `get_data_model({type: 'Actor', subtype: '<type>'})` to learn the structure."
      ),
      items:          z.array(z.record(z.string(), z.any())).optional().describe(
        "Optional inline items to attach at creation. Each entry is either "
        + "{ pack, documentId, nameOverride? } (from a compendium) or "
        + "{ name, type, system, ... } (inline definition)."
      ),
      img:            z.string().optional().describe("Portrait image path/URL."),
      prototypeToken: z.record(z.string(), z.any()).optional().describe(
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
      items:   z.array(z.record(z.string(), z.any())).describe(
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

  // --- Delete: folder ---
  registerRoutedTool(mcp, "delete_folder",
    "Delete a folder by id. Foundry orphans contained documents by default "
    + "(sets their folder to null). Pass `deleteContents: true` to also "
    + "delete every document and subfolder inside. Permanent — Foundry's "
    + "undo doesn't cover deletes.",
    {
      folderId:       z.string().describe("Folder document id."),
      deleteContents: z.boolean().optional().describe(
        "If true, delete all contained documents and subfolders too. Default false (orphan)."
      ),
    });

  // --- Delete: actor ---
  registerRoutedTool(mcp, "delete_actor",
    "Delete an actor by id. Permanent — Foundry's undo doesn't cover document "
    + "deletion. If any data on the actor needs to survive, call `get_actor` "
    + "or `snapshot_actor` first.",
    {
      actorId: z.string().describe("Actor document id."),
    });

  // --- Update: actor ---
  registerRoutedTool(mcp, "update_actor",
    "Patch an existing actor's top-level fields and/or system data. Use this "
    + "to tweak HP/stats/name/img/portrait after `create_actor_from_compendium` "
    + "instead of recreating the actor from scratch. At least one of `name`, "
    + "`img`, `system`, or `prototypeToken` is required.",
    {
      actorId:        z.string().describe("Actor document id."),
      name:           z.string().optional().describe("Replace the actor's name."),
      img:            z.string().optional().describe("Replace the portrait image path/URL."),
      system:         z.record(z.string(), z.any()).optional().describe(
        "Merge into the actor's `system` data. Use `get_data_model` for the active system's shape."
      ),
      prototypeToken: z.record(z.string(), z.any()).optional().describe(
        "Merge into the prototype token (affects future tokens placed from this actor)."
      ),
    });

  // --- Items on actor: delete ---
  registerRoutedTool(mcp, "delete_items_from_actor",
    "Remove embedded items from an actor by id. Items not on the actor are "
    + "returned in `missing`; the rest are deleted.",
    {
      actorId: z.string().describe("Actor document id."),
      itemIds: z.array(z.string()).describe("Embedded item ids to remove."),
    });

  // --- Items on actor: update ---
  registerRoutedTool(mcp, "update_item_on_actor",
    "Patch a single embedded item on an actor. `data` is merged into the "
    + "item document — top-level fields like `name`, `img`, and "
    + "`system.*` sub-paths are all accepted.",
    {
      actorId: z.string().describe("Actor document id."),
      itemId:  z.string().describe("Embedded item id."),
      data:    z.record(z.string(), z.any()).describe(
        "Fields to merge into the item. Foundry's diff-update semantics apply."
      ),
    });

  // --- Delete: journal entry ---
  registerRoutedTool(mcp, "delete_journal_entry",
    "Delete a journal entry and all of its pages. Permanent — Foundry's "
    + "undo doesn't cover document deletion.",
    {
      journalId: z.string().describe("Journal entry document id."),
    });

  // --- Delete: journal page ---
  registerRoutedTool(mcp, "delete_journal_page",
    "Delete a single page from a journal entry. The entry itself remains.",
    {
      journalId: z.string().describe("Parent journal entry id."),
      pageId:    z.string().describe("Page id to delete."),
    });

  // --- Add page to journal entry ---
  registerRoutedTool(mcp, "add_page_to_journal_entry",
    "Add a new page to an existing journal entry. Page shape matches the "
    + "entries in `create_journal_entry`'s `pages[]`.",
    {
      journalId: z.string().describe("Parent journal entry id."),
      page:      z.object({
        name:    z.string().describe("Page name."),
        type:    z.enum(["text", "image", "pdf", "video"]).optional().describe("Default 'text'."),
        text:    z.object({
          content: z.string(),
          format:  z.union([z.literal(1), z.literal(2)]).optional(),
        }).optional(),
        src:     z.string().optional().describe("URL/path for image/pdf/video pages."),
      }).describe("Page to add."),
    });

  // --- Scene: place a token ---
  registerRoutedTool(mcp, "create_token",
    "Place a new token for an actor onto a scene. Defaults to the active "
    + "scene when `sceneId` is omitted. Pass coordinates as EITHER `x`/`y` "
    + "in pixels OR `gridX`/`gridY` in cells (cell coords win if both are "
    + "provided). The token inherits the actor's prototype token settings; "
    + "use the optional `hidden`/`name`/`rotation` to override.",
    {
      actorId:  z.string().describe("Actor whose token to place."),
      sceneId:  z.string().optional().describe("Target scene id. Default: active scene."),
      x:        z.number().optional().describe("X position in pixels. Use this OR gridX."),
      y:        z.number().optional().describe("Y position in pixels. Use this OR gridY."),
      gridX:    z.number().optional().describe("Grid cell column (0-indexed). Multiplied by scene grid size."),
      gridY:    z.number().optional().describe("Grid cell row (0-indexed). Multiplied by scene grid size."),
      hidden:   z.boolean().optional().describe("Spawn the token hidden to non-GMs."),
      name:     z.string().optional().describe("Override the token name (defaults to the actor name)."),
      rotation: z.number().optional().describe("Token rotation in degrees."),
    });

  // --- Ownership: set ---
  registerRoutedTool(mcp, "set_actor_ownership",
    "Set ownership levels on an actor. The `ownership` param is a map of "
    + "{ user → level }. Keys can be `default`, a userId, or an exact "
    + "case-sensitive userName. Levels are strings (NONE/LIMITED/OBSERVER/"
    + "OWNER/INHERIT) or the corresponding integers (0/1/2/3/-1). The map "
    + "is MERGED with existing ownership — to clear a user's permission, "
    + "pass them as `NONE` explicitly.",
    {
      actorId:   z.string().describe("Actor document id."),
      ownership: z.record(z.string(), z.union([
        z.enum(["NONE", "LIMITED", "OBSERVER", "OWNER", "INHERIT"]),
        z.number().int().min(-1).max(3)
      ])).describe(
        "Map of user → level. Use `default` for non-listed users. "
        + "Example: { default: \"NONE\", \"Bob\": \"OWNER\" }."
      ),
    });

  // --- Ownership: read ---
  registerRoutedTool(mcp, "get_actor_ownership",
    "Read the current ownership map of an actor — returns level names "
    + "(NONE/LIMITED/OBSERVER/OWNER) and resolved Foundry user names.",
    {
      actorId: z.string().describe("Actor document id."),
    });

  // --- Combat: start ---
  registerRoutedTool(mcp, "start_combat",
    "Start a combat encounter. Creates one on the current scene if none "
    + "exists yet. Optionally adds tokens as combatants and rolls initiative "
    + "before starting.",
    {
      tokenIds:       z.array(z.string()).optional().describe("Token ids to add as combatants before starting."),
      rollInitiative: z.union([z.boolean(), z.enum(["all", "npc"])]).optional().describe(
        "If true or 'all', roll for every combatant. If 'npc', only roll for NPC combatants. Default: no auto-roll."
      ),
    });

  // --- Combat: end ---
  registerRoutedTool(mcp, "end_combat",
    "End the active combat encounter (deletes it). The token roster on the "
    + "scene is unaffected — only the combat tracker entry is removed.",
    {});

  // --- Combat: advance ---
  registerRoutedTool(mcp, "advance_combat",
    "Advance the combat turn. Foundry handles round transitions "
    + "automatically when wrapping past the last combatant.",
    {
      direction: z.enum(["next", "previous"]).optional().describe("Default 'next'."),
    });

  // --- Chat: send message ---
  registerRoutedTool(mcp, "send_chat_message",
    "Send a chat message. Speaker defaults to the routed user (the GM by "
    + "default). Pass `actorId` or `tokenId` to speak as that document; pass "
    + "`whisperTo` (userName or array) to make it a whisper.",
    {
      content:   z.string().describe("HTML content of the message."),
      speaker:   z.string().optional().describe("Display alias for the speaker."),
      actorId:   z.string().optional().describe("Speak as this actor."),
      tokenId:   z.string().optional().describe("Speak as this token (on the active scene)."),
      whisperTo: z.union([z.string(), z.array(z.string())]).optional().describe(
        "User name(s) to whisper to. Other users won't see the message."
      ),
      type:      z.union([
        z.enum(["OOC", "IC", "EMOTE", "WHISPER", "ROLL", "OTHER"]),
        z.number().int()
      ]).optional().describe("Message type. Default 'OOC' (out-of-character)."),
    });

  // --- Roll request (raw — needs longer timeout than the 15s default) ---
  registerRawTool(mcp, "request_roll",
    "Pop a Roll dialog on the target user's screen. The user clicks Roll or "
    + "Cancel; this tool returns when they respond (or after `timeoutSeconds`). "
    + "Set `autoAccept: true` to skip the dialog and roll immediately — handy "
    + "for GM-side automation or test scenarios.",
    {
      formula:        z.string().describe("Dice formula (e.g. '1d20+5', '2d6', '@abilities.str.mod + 1d20')."),
      prompt:         z.string().optional().describe("Text shown in the dialog. Default: 'The GM is requesting a roll.'"),
      label:          z.string().optional().describe("Short label for the dialog title + chat flavor (e.g. 'Perception DC 15')."),
      timeoutSeconds: z.number().int().min(5).max(300).optional().describe("Dialog wait time. Default 60s, max 300s."),
      autoAccept:     z.boolean().optional().describe("Skip the dialog and roll immediately. Default false."),
      targetUser:     z.string().optional().describe(TARGET_USER_DESC),
    },
    async (params) => {
      const { targetUser, timeoutSeconds = 60, ...rest } = params;
      // Server-side RPC needs a slightly longer timeout than the dialog so
      // the dialog timeout fires inside the bridge, not at the server layer.
      const bridgeTimeoutMs = Math.max(15_000, (timeoutSeconds + 5) * 1000);
      return callFoundry("request_roll", { ...rest, timeoutSeconds }, targetUser, bridgeTimeoutMs);
    });
}
