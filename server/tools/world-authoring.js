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
import { registerRoutedTool, registerRawTool, registerMergedTool, TARGET_USER_DESC, AUDIT_DESC } from "./_helpers.js";
import { callFoundry }                           from "../lib/foundry-rpc.js";
import { ALLOW_SELF_TEST, ALLOW_WRITE }          from "../lib/config.js";

export function registerWorldAuthoringTools(mcp) {
  if (!ALLOW_WRITE) return;

  if (ALLOW_SELF_TEST) {
    registerRoutedTool(mcp, "self_test",
      "Run a destructive schema-drift smoke test using uniquely flagged throwaway "
      + "Actor, JournalEntry, RollTable, and Scene documents. Always attempts "
      + "ID-based cleanup in finally and fails if anything remains.",
      {
        confirm: z.literal(true).describe(
          "Required acknowledgement that this tool temporarily creates and deletes world documents."
        ),
      });
  }

  // --- Folders (merged: create_folder, delete_folder) ---
  registerMergedTool(mcp, "folder",
    "Create or delete a Foundry sidebar folder. "
    + "action 'create' needs type+name (parentFolder/color optional; idempotent — "
    + "returns an existing folder with the same type+name+parentFolder as `existed: true`). "
    + "action 'delete' needs folderId (deleteContents optional — when true also deletes "
    + "contained documents/subfolders, else they are orphaned). Permanent on delete.",
    {
      action: z.enum(["create", "delete"]).describe("Folder operation to perform."),
      // create
      type:         z.enum(["Actor", "Item", "JournalEntry", "Scene", "Macro", "Playlist", "RollTable", "Cards"])
                      .optional().describe("[create] Sidebar document type the folder will hold."),
      name:         z.string().optional().describe("[create] Folder name (case-sensitive)."),
      parentFolder: z.string().optional().describe(
        "[create] Optional parent folder. Accepts a folder document id or an exact "
        + "name match within the same `type`."
      ),
      color:        z.string().optional().describe(
        "[create] Optional hex color (e.g. '#3a5'). Foundry shows this on the folder header."
      ),
      // delete
      folderId:       z.string().optional().describe("[delete] Folder document id."),
      deleteContents: z.boolean().optional().describe(
        "[delete] If true, delete all contained documents and subfolders too. Default false (orphan)."
      ),
      audit:        z.boolean().optional().describe(AUDIT_DESC),
    },
    { create: "create_folder", delete: "delete_folder" },
    "action",
    { create: ["type", "name"], delete: ["folderId"] });

  // --- Actor write (merged: create_actor, create_actor_from_compendium, update_actor, delete_actor) ---
  registerMergedTool(mcp, "actor_write",
    "Create, import, update, or delete a world actor. "
    + "action 'create' needs name+type (system/items/img/prototypeToken/folderId/folderName optional) — "
    + "builds a new actor from scratch; call get_data_model first to learn the system block shape. "
    + "action 'fromCompendium' needs pack+documentId (folderId/folderName/nameOverride optional) — "
    + "imports an already-statted actor from a compendium pack. "
    + "action 'update' needs actorId plus at least one of name/img/system/prototypeToken — patches an actor. "
    + "action 'delete' needs actorId — permanent (Foundry's undo does not cover deletes).",
    {
      action: z.enum(["create", "fromCompendium", "update", "delete"]).describe("Actor operation to perform."),
      // shared id (update/delete)
      actorId:        z.string().optional().describe("[update/delete] Actor document id."),
      // create
      name:           z.string().optional().describe("[create] Actor name. [update] Replace the actor's name."),
      type:           z.string().optional().describe(
        "[create] Actor subtype, system-specific (e.g. 'character', 'npc' for dnd5e; "
        + "'Player' for shadowdark). Use `get_data_model({type: 'Actor'})` "
        + "to see valid types in the active system."
      ),
      system:         z.record(z.string(), z.any()).optional().describe(
        "[create] System-specific data block. Shape varies per game system. "
        + "Use `get_data_model({type: 'Actor', subtype: '<type>'})` to learn the structure. "
        + "[update] Merge into the actor's `system` data."
      ),
      items:          z.array(z.record(z.string(), z.any())).optional().describe(
        "[create] Optional inline items to attach at creation. Each entry is either "
        + "{ pack, documentId, nameOverride? } (from a compendium) or "
        + "{ name, type, system, ... } (inline definition)."
      ),
      img:            z.string().optional().describe("[create] Portrait image path/URL. [update] Replace the portrait image path/URL."),
      prototypeToken: z.record(z.string(), z.any()).optional().describe(
        "[create] Optional prototype token data (img, scale, disposition, etc.). "
        + "[update] Merge into the prototype token (affects future tokens placed from this actor)."
      ),
      folderId:       z.string().optional().describe("[create/fromCompendium] Target folder id (wins over folderName if both given)."),
      folderName:     z.string().optional().describe(
        "[create/fromCompendium] Target folder by exact name. Auto-created as an Actor folder if it doesn't exist."
      ),
      // fromCompendium
      pack:           z.string().optional().describe("[fromCompendium] Compendium pack id (e.g. 'dnd5e.monsters')."),
      documentId:     z.string().optional().describe("[fromCompendium] Document id within the pack."),
      nameOverride:   z.string().optional().describe("[fromCompendium] Rename the imported actor."),
      audit:          z.boolean().optional().describe(AUDIT_DESC),
    },
    {
      create:         "create_actor",
      fromCompendium: "create_actor_from_compendium",
      update:         "update_actor",
      delete:         "delete_actor",
    },
    "action",
    {
      create:         ["name", "type"],
      fromCompendium: ["pack", "documentId"],
      update:         ["actorId"],
      delete:         ["actorId"],
    });

  // --- Actor items (merged: add_items_to_actor, update_item_on_actor, delete_items_from_actor) ---
  registerMergedTool(mcp, "actor_items",
    "Manage embedded items (weapons, spells, gear, features) on an existing actor. "
    + "action 'add' needs actorId+items — items are { pack, documentId, nameOverride? } "
    + "(compendium ref) OR { name, type, system?, ... } (inline). "
    + "action 'update' needs actorId+itemId+data — merges `data` into one embedded item. "
    + "action 'delete' needs actorId+itemIds — removes embedded items by id (missing ones reported).",
    {
      action: z.enum(["add", "update", "delete"]).describe("Actor-item operation to perform."),
      actorId: z.string().describe("Actor document id."),
      // add
      items:   z.array(z.record(z.string(), z.any())).optional().describe(
        "[add] Items to add. Each entry is { pack, documentId, nameOverride? } "
        + "(compendium ref) OR { name, type, system?, ... } (inline)."
      ),
      // update
      itemId:  z.string().optional().describe("[update] Embedded item id."),
      data:    z.record(z.string(), z.any()).optional().describe(
        "[update] Fields to merge into the item. Foundry's diff-update semantics apply."
      ),
      // delete
      itemIds: z.array(z.string()).optional().describe("[delete] Embedded item ids to remove."),
      audit:   z.boolean().optional().describe(AUDIT_DESC),
    },
    {
      add:    "add_items_to_actor",
      update: "update_item_on_actor",
      delete: "delete_items_from_actor",
    },
    "action",
    {
      add:    ["actorId", "items"],
      update: ["actorId", "itemId", "data"],
      delete: ["actorId", "itemIds"],
    });

  // --- Actor ownership (merged: get_actor_ownership, set_actor_ownership) ---
  registerMergedTool(mcp, "actor_ownership",
    "Read or set an actor's ownership map. "
    + "action 'get' needs actorId — returns level names (NONE/LIMITED/OBSERVER/OWNER) "
    + "and resolved Foundry user names. "
    + "action 'set' needs actorId+ownership — a map of user → level MERGED with existing "
    + "ownership (to clear a user, pass them as NONE explicitly).",
    {
      action: z.enum(["get", "set"]).describe("Ownership operation to perform."),
      actorId:   z.string().describe("Actor document id."),
      ownership: z.record(z.string(), z.union([
        z.enum(["NONE", "LIMITED", "OBSERVER", "OWNER", "INHERIT"]),
        z.number().int().min(-1).max(3)
      ])).optional().describe(
        "[set] Map of user → level. Keys can be `default`, a userId, or an exact "
        + "case-sensitive userName. Levels are strings (NONE/LIMITED/OBSERVER/OWNER/INHERIT) "
        + "or integers (0/1/2/3/-1). Example: { default: \"NONE\", \"Bob\": \"OWNER\" }."
      ),
      audit:     z.boolean().optional().describe(AUDIT_DESC),
    },
    { get: "get_actor_ownership", set: "set_actor_ownership" },
    "action",
    { get: ["actorId"], set: ["actorId", "ownership"] });

  // --- Journal (merged: create_journal_entry, add_page_to_journal_entry, update_journal_page, delete_journal_page, delete_journal_entry) ---
  registerMergedTool(mcp, "journal",
    "Manage journal entries and their pages. "
    + "action 'create' needs name+pages (folderId/folderName optional) — creates an entry with pages. "
    + "action 'addPage' needs journalId+page — appends a page to an existing entry. "
    + "action 'updatePage' needs journalId+pageId (name/content/appendContent optional) — "
    + "use `content` to replace the body or `appendContent` to add to it. "
    + "action 'deletePage' needs journalId+pageId — deletes one page; the entry remains. "
    + "action 'delete' needs journalId — deletes the entry and all its pages (permanent).",
    {
      action: z.enum(["create", "addPage", "updatePage", "deletePage", "delete"]).describe("Journal operation to perform."),
      // create
      name:       z.string().optional().describe("[create] Journal entry name (shown in the sidebar). [updatePage] Replace the page name."),
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
      })).optional().describe("[create] At least one page."),
      folderId:   z.string().optional().describe("[create] Target folder id."),
      folderName: z.string().optional().describe(
        "[create] Target folder by exact name. Auto-created as a JournalEntry folder if missing."
      ),
      // page-level ops
      journalId:  z.string().optional().describe("[addPage/updatePage/deletePage/delete] Parent journal entry id."),
      pageId:     z.string().optional().describe("[updatePage/deletePage] Page id within that journal."),
      // addPage
      page:       z.object({
        name:    z.string().describe("Page name."),
        type:    z.enum(["text", "image", "pdf", "video"]).optional().describe("Default 'text'."),
        text:    z.object({
          content: z.string(),
          format:  z.union([z.literal(1), z.literal(2)]).optional(),
        }).optional(),
        src:     z.string().optional().describe("URL/path for image/pdf/video pages."),
      }).optional().describe("[addPage] Page to add (shape matches a create `pages[]` entry)."),
      // updatePage
      content:       z.string().optional().describe("[updatePage] Replace the page body (HTML or Markdown per the page's format)."),
      appendContent: z.string().optional().describe("[updatePage] Append to the existing page body. Ignored if `content` is also provided."),
      audit:      z.boolean().optional().describe(AUDIT_DESC),
    },
    {
      create:     "create_journal_entry",
      addPage:    "add_page_to_journal_entry",
      updatePage: "update_journal_page",
      deletePage: "delete_journal_page",
      delete:     "delete_journal_entry",
    },
    "action",
    {
      create:     ["name", "pages"],
      addPage:    ["journalId", "page"],
      updatePage: ["journalId", "pageId"],
      deletePage: ["journalId", "pageId"],
      delete:     ["journalId"],
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
      audit:    z.boolean().optional().describe(AUDIT_DESC),
    });

  // --- Combat (merged: start_combat, advance_combat, end_combat) ---
  registerMergedTool(mcp, "combat",
    "Control the combat tracker. "
    + "action 'start' (tokenIds/rollInitiative optional) — starts an encounter, creating one "
    + "on the current scene if none exists; can add tokens as combatants and roll initiative first. "
    + "action 'advance' (direction optional, default 'next') — advances the turn; Foundry handles "
    + "round transitions automatically. "
    + "action 'end' — ends/deletes the active combat (the scene token roster is unaffected).",
    {
      action: z.enum(["start", "advance", "end"]).describe("Combat operation to perform."),
      // start
      tokenIds:       z.array(z.string()).optional().describe("[start] Token ids to add as combatants before starting."),
      rollInitiative: z.union([z.boolean(), z.enum(["all", "npc"])]).optional().describe(
        "[start] If true or 'all', roll for every combatant. If 'npc', only roll for NPC combatants. Default: no auto-roll."
      ),
      // advance
      direction: z.enum(["next", "previous"]).optional().describe("[advance] Default 'next'."),
      audit:     z.boolean().optional().describe(AUDIT_DESC),
    },
    { start: "start_combat", advance: "advance_combat", end: "end_combat" },
    "action",
    { start: [], advance: [], end: [] });

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
      audit:     z.boolean().optional().describe(AUDIT_DESC),
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
      audit:          z.boolean().optional().describe(AUDIT_DESC),
    },
    async (params) => {
      const { targetUser, timeoutSeconds = 60, ...rest } = params;
      // Server-side RPC needs a slightly longer timeout than the dialog so
      // the dialog timeout fires inside the bridge, not at the server layer.
      const bridgeTimeoutMs = Math.max(15_000, (timeoutSeconds + 5) * 1000);
      return callFoundry("request_roll", { ...rest, timeoutSeconds }, targetUser, bridgeTimeoutMs);
    });

  // --- Typed roll (v0.10.0) ---
  const _checkSchema = {
    actorId:    z.string().describe("Actor ID or name."),
    type:       z.enum(["skill", "ability", "save"]).describe("Category of the roll."),
    identifier: z.string().describe("System-specific ID for the roll (e.g. 'ath' for 5e Athletics, 'athletics' for PF2e, 'str' for Shadowdark stat)."),
    dc:         z.number().optional().describe("Target DC for success evaluation."),
    adv:        z.enum(["normal", "advantage", "disadvantage"]).optional().describe("Force advantage state (dnd5e + shadowdark only; ignored elsewhere)."),
    audit:      z.boolean().optional().describe(AUDIT_DESC),
  };

  // Canonical name from v0.12.1 onward.
  registerRoutedTool(mcp, "request_check",
    "Triggers a system-native skill, ability, or save check on an actor. "
    + "Handles system-specific modifiers and formatting. Dialogs always "
    + "suppressed. Replaces `request_roll_typed` (kept as alias).",
    _checkSchema,
    "request_roll_typed"  // bridge-side handler name unchanged
  );

  // --- Item use (merged: request_item_use, request_attack_roll, request_damage_roll) ---
  registerRawTool(mcp, "request_item_use",
    "Trigger an item's combat workflow. The `phase` selects which part runs and which params apply. "
    + "Dialogs always suppressed.\n"
    + "• phase 'full' (routes to request_item_use) → full attack-and-damage workflow: "
    + "Attack -> Hit? -> Damage -> (optional) Apply. Recommended for combat actions — threads crit state from "
    + "the attack into damage automatically. Needs actorId+itemId; targetIds optional (damage applied to these "
    + "targets on hit); activityId/adv optional.\n"
    + "• phase 'attack' (routes to request_attack_roll) → only the attack roll. Needs actorId+itemId; "
    + "activityId/adv optional.\n"
    + "• phase 'damage' (routes to request_damage_roll) → only the damage roll; caller supplies crit state. "
    + "Does NOT re-roll the attack — fetches the activity/strike directly from the item. Needs actorId+itemId; "
    + "isCritical optional.",
    {
      phase:      z.enum(["full", "attack", "damage"]).describe("Which workflow part to run."),
      actorId:    z.string().describe("Actor ID or name."),
      itemId:     z.string().describe("Item/weapon ID or name."),
      targetIds:  z.array(z.string()).optional().describe("[full] If provided, damage is applied to these targets on hit."),
      activityId: z.string().optional().describe("[full/attack] D&D 5e specific activity ID (when an item has multiple attack activities)."),
      adv:        z.enum(["normal", "advantage", "disadvantage"]).optional().describe("[full/attack] Force advantage state (system-dependent)."),
      isCritical: z.boolean().optional().describe("[damage] Force critical damage (doubles dice on d20 systems)."),
      audit:      z.boolean().optional().describe(AUDIT_DESC),
      targetUser: z.string().optional().describe(TARGET_USER_DESC),
    },
    // Custom callback (not registerMergedTool) so the `full` phase keeps its
    // per-target timeout scaling — many-target AoE damage application is slow
    // and would otherwise hit the 15s default RPC timeout. attack/damage use
    // the default timeout.
    async (params) => {
      const { phase = "full", targetUser, ...rest } = params;
      const bridgeTool = { full: "request_item_use", attack: "request_attack_roll", damage: "request_damage_roll" }[phase];
      if (!bridgeTool) {
        return { content: [{ type: "text", text: `Error: unknown phase "${phase}" for request_item_use (use full|attack|damage).` }] };
      }
      let timeoutMs;
      if (phase === "full") {
        rest.targetIds = Array.isArray(rest.targetIds) ? rest.targetIds : [];
        timeoutMs = Math.max(15_000, 10_000 + (rest.targetIds.length * 5000));
      }
      return callFoundry(bridgeTool, rest, targetUser, timeoutMs);
    });

  // --- Apply damage (v0.10.0) ---
  registerRoutedTool(mcp, "apply_damage",
    "Applies damage to one or more targets with mixed outcomes (AoE support).",
    {
      damages: z.array(z.object({
        targetId:   z.string().describe("Target actor/token ID."),
        amount:     z.number().describe("Total damage value."),
        type:       z.string().optional().describe("Damage type (e.g. 'fire')."),
        multiplier: z.number().optional().describe("Multiplier (e.g. 0.5 for half)."),
      })).describe("Per-target damage descriptors."),
      audit:  z.boolean().optional().describe(AUDIT_DESC),
    });

  // --- Scene levels (merged: add_scene_level, update_scene_level, remove_scene_level) ---
  registerMergedTool(mcp, "scene_level",
    "Manage levels (floors) of a multi-level scene. v14 only — `scene.levels` is a "
    + "v14-native EmbeddedCollection. "
    + "action 'add' needs sceneId+name+bottom+top — adds a level; returns its id, name, "
    + "and elevation range. "
    + "action 'update' needs sceneId+levelId (name/bottom/top optional) — changes the given "
    + "fields, preserving the rest. "
    + "action 'remove' needs sceneId+levelId — deletes a level (refuses on the only remaining one; permanent).",
    {
      action: z.enum(["add", "update", "remove"]).describe("Scene-level operation to perform."),
      sceneId: z.string().describe("Target scene id."),
      // add / update level name
      name:    z.string().optional().describe("[add] Level name (e.g. 'Ground', 'Upper', 'Basement'). [update] New level name."),
      bottom:  z.number().optional().describe("[add] Lower bound of the level's elevation range (in feet). [update] New lower elevation bound."),
      top:     z.number().optional().describe("[add] Upper bound of the level's elevation range (in feet). [update] New upper elevation bound."),
      // update / remove
      levelId: z.string().optional().describe("[update/remove] Level document id."),
      audit:   z.boolean().optional().describe(AUDIT_DESC),
    },
    { add: "add_scene_level", update: "update_scene_level", remove: "remove_scene_level" },
    "action",
    {
      add:    ["sceneId", "name", "bottom", "top"],
      update: ["sceneId", "levelId"],
      remove: ["sceneId", "levelId"],
    });

  // --- Region (merged: create_region, update_region, delete_region) ---
  registerMergedTool(mcp, "region",
    "Manage Regions (v13+) on a scene. Use `list_region_behavior_types` for behavior subtype schemas. "
    + "action 'create' needs sceneId+name+shapes (behaviors/levels/color/visibility/locked/elevation/ownership optional). "
    + "action 'update' needs sceneId+regionId+patch — `patch` is merged into the document "
    + "(dotted paths like `elevation.bottom` accepted). "
    + "action 'delete' needs sceneId+regionId — permanent.",
    {
      action: z.enum(["create", "update", "delete"]).describe("Region operation to perform."),
      sceneId:    z.string().describe("Target scene id."),
      // create
      name:       z.string().optional().describe("[create] Region name."),
      shapes:     z.array(z.record(z.string(), z.any())).optional().describe(
        "[create] Non-empty array of RegionShape data (e.g. {type:'rectangle', x, y, width, height})."
      ),
      behaviors:  z.array(z.record(z.string(), z.any())).optional().describe(
        "[create] RegionBehavior data (e.g. {type:'executeScript', system:{source}})."
      ),
      levels:     z.array(z.string()).optional().describe("[create] Level ids the region applies to."),
      color:      z.string().optional().describe("[create] Hex color for the region overlay."),
      visibility: z.number().int().optional().describe("[create] Visibility level (0–4 per Foundry's enum)."),
      locked:     z.boolean().optional().describe("[create] Lock the region from interactive selection."),
      elevation:  z.record(z.string(), z.any()).optional().describe("[create] Override elevation range {bottom, top}."),
      ownership:  z.record(z.string(), z.any()).optional().describe("[create] Per-user ownership map."),
      // update / delete
      regionId:   z.string().optional().describe("[update/delete] Region document id."),
      patch:      z.record(z.string(), z.any()).optional().describe(
        "[update] Fields to merge into the region (e.g. {visibility: 0, locked: false})."
      ),
      audit:      z.boolean().optional().describe(AUDIT_DESC),
    },
    { create: "create_region", update: "update_region", delete: "delete_region" },
    "action",
    {
      create: ["sceneId", "name", "shapes"],
      update: ["sceneId", "regionId", "patch"],
      delete: ["sceneId", "regionId"],
    });

  // --- Scene (merged: create_scene, update_scene, activate_scene, delete_scene) ---
  registerMergedTool(mcp, "scene",
    "Create, update, activate, or delete a scene. "
    + "action 'create' needs name (width/height/padding/grid*/backgroundColor/background/foreground/"
    + "levelFog/fog/fogExploration/folderId/activate optional) — activates the new scene unless activate:false. "
    + "action 'update' needs sceneId plus the whitelisted fields to patch (name, padding, backgroundColor, "
    + "background, foreground, levelFog, fog, grid, navigation, sort, navName, fogExploration, initial). "
    + "action 'activate' needs sceneId or sceneName — switches the canvas to view it. "
    + "action 'delete' needs sceneId or sceneName (force optional — required to delete the active scene). Permanent.",
    {
      action: z.enum(["create", "update", "activate", "delete"]).describe("Scene operation to perform."),
      // shared id / name
      sceneId:   z.string().optional().describe("[update] Target scene id. [activate/delete] Scene document id (preferred — unambiguous)."),
      sceneName: z.string().optional().describe("[activate/delete] Scene name (exact match). Used only if `sceneId` is omitted."),
      name:      z.string().optional().describe("[create] Scene name (shown in the sidebar). [update] New scene name."),
      // create-specific geometry
      width:           z.number().int().optional().describe("[create] Width in pixels. Default 4000."),
      height:          z.number().int().optional().describe("[create] Height in pixels. Default 3000."),
      gridType:        z.number().int().optional().describe("[create] CONST.GRID_TYPES value (0=Gridless, 1=Square, 2-5=Hex variants). Default 1 (Square)."),
      gridSize:        z.number().int().optional().describe("[create] Grid cell size in pixels. Default 100."),
      gridAlpha:       z.number().optional().describe("[create] Grid line alpha (0.0–1.0). Default 0.2."),
      folderId:        z.string().optional().describe("[create] Parent folder id (Scene type)."),
      activate:        z.boolean().optional().describe("[create] Activate after creating. Default true."),
      // shared create/update fields
      padding:         z.number().optional().describe("[create] Outer padding (0.0–0.5). Default 0.25. [update] New padding."),
      backgroundColor: z.string().optional().describe("[create] Hex background color. Default '#1c1c1c'. [update] New hex background color."),
      background:      z.union([z.string(), z.record(z.string(), z.any())]).optional().describe(
        "[create] Background image path or data object. [update] Background data object (e.g. {src: 'path/to/image.webp'}). "
        + "On v14 background fields map to Level.background and transforms to Level.textures."
      ),
      foreground:      z.record(z.string(), z.any()).optional().describe("[create/update] Foreground texture data; Level-backed on v14."),
      levelFog:        z.record(z.string(), z.any()).optional().describe("[create/update] Level fog texture data {src, tint}; v14 only."),
      fog:             z.record(z.string(), z.any()).optional().describe("[create/update] Scene fog config, e.g. {mode: 0|1|2, colors}."),
      fogExploration:  z.boolean().optional().describe("[create/update] Compatibility boolean for fog exploration. On v14 update maps false→fog.mode 0 and true→fog.mode 1."),
      // update-only fields
      grid:            z.record(z.string(), z.any()).optional().describe("[update] Grid object (e.g. {size: 100, type: 1, alpha: 0.2})."),
      navigation:      z.boolean().optional().describe("[update] Whether the scene appears in the navigation bar."),
      sort:            z.number().int().optional().describe("[update] Navigation sort order."),
      navName:         z.string().optional().describe("[update] Short name shown in the navigation bar."),
      initial:         z.record(z.string(), z.any()).optional().describe("[update] Initial view config (e.g. {level: '<levelId>', x, y, scale})."),
      // delete-only
      force:     z.boolean().optional().describe("[delete] Set true to delete even if the scene is currently active. Default false."),
      audit:     z.boolean().optional().describe(AUDIT_DESC),
    },
    {
      create:   "create_scene",
      update:   "update_scene",
      activate: "activate_scene",
      delete:   "delete_scene",
    },
    "action",
    {
      create:   ["name"],
      update:   ["sceneId"],
      activate: [],
      delete:   [],
    });

  // --- List scenes (v0.11.2) ---
  registerRoutedTool(mcp, "list_scenes",
    "List every scene in the world as `{id, name, active, folder}` per scene. "
    + "Use to enumerate available scenes when you only know a name fragment "
    + "or need to find which scene is currently active.",
    {});

  // --- Place measured template (v0.11) ---
  registerRoutedTool(mcp, "place_measured_template",
    "Drop a MeasuredTemplate onto a scene (fireball circle, cone, wall ray, "
    + "rectangle). Used for spell areas of effect. The template is created "
    + "immediately at the given coordinates — no preview/place UX. On Foundry "
    + "v14+, templates are stored as Region documents (v14 merged "
    + "MeasuredTemplate into Region); the tool returns the same template "
    + "fields on both versions.",
    {
      type:      z.enum(["circle", "cone", "rect", "ray"]).optional().describe("Template shape. Default 'circle'."),
      x:         z.number().describe("X pixel coordinate of the template origin."),
      y:         z.number().describe("Y pixel coordinate of the template origin."),
      distance:  z.number().describe("Template distance in grid units (e.g. 20 for a 20ft cone)."),
      direction: z.number().optional().describe("Direction in degrees (for cone/ray). Default 0."),
      angle:     z.number().optional().describe("Cone angle in degrees. Default 53 for cones, 0 otherwise."),
      width:     z.number().optional().describe("Ray width (for type='ray'). Default 0."),
      fillColor: z.string().optional().describe("Hex color for the template fill. Defaults to the user's color."),
      texture:   z.string().optional().describe("Optional texture image path overlaying the template."),
      flags:     z.record(z.string(), z.any()).optional().describe(
        "Module flags to attach (e.g. { 'spell-effects': { name: 'fireball' } })."
      ),
      sceneId:   z.string().optional().describe("Target scene id. Default: active scene."),
      hidden:    z.boolean().optional().describe("Create hidden to non-GMs. Default false."),
      audit:     z.boolean().optional().describe(AUDIT_DESC),
    });
}
