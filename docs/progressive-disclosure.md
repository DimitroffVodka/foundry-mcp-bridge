# Milestone (planned): progressive disclosure for tool context

**Status:** planned / next phase — not yet implemented.

## Problem
The server defines ~98 tools (~54 in a read-only install, ~96 with write+eval).
Every tool's name + description + schema is injected into the model's context on
*every* request. That's real cost (the "30–60k tokens of metadata" problem),
degrades tool-selection accuracy, and exceeds some client caps (Cursor ~80;
Claude 120; OpenAI 128). A full write+eval install is already over Cursor's cap.

## Decision
Adopt **progressive disclosure** (a.k.a. tool facade / just-in-time tools): keep
*all* tools available, but expose only a tiny always-on core plus discovery
meta-tools, and load the rest on demand. This is the only approach that meets all
three constraints we set:

1. **Don't limit options** — every tool stays reachable.
2. **Leaner context** — only a handful of tool schemas loaded at a time.
3. **No operator decisions** — automatic; nobody picks tool groups.

Approaches we explicitly rejected and why:
- **Tool groups / profiles** — requires the operator to choose, which we don't
  want to impose (and most operators won't know what to pick).
- **Client-side reranking** (e.g. anything-llm's embedding reranker, top-15) — it
  lives in the agent runtime, so the server can't impose it on Claude
  Desktop/Cursor, and it risks recall failure (the needed tool filtered out).
- **Gateway facade** (e.g. solo.io / agentgateway `toolMode: Search`) — works, but
  adds infra; for a *distributed* product, baking it into the server is cleaner.

## Proposed shape (server-side)
Register only:
- a tiny **always-on core** (liveness/info + `evaluate` when env-enabled — `eval`
  is itself a universal "code-mode" tool),
- **`search_tools(query)`** → returns the few best-matching tools *with full
  schemas* (preserves tool-use accuracy for what's actually used),
- **`get_tool(name)`** → full schema on demand,
- **`invoke_tool(name, args)`** → validates against the catalog schema and routes
  to the existing handler.

The existing 98 handlers stay; they're just not all registered as MCP tools —
their definitions live in a catalog that `search_tools`/`get_tool` read and
`invoke_tool` dispatches against. Default-on, with a flat-mode escape hatch for
clients that struggle with the indirection.

## Tradeoff (accepted, to be mitigated)
Progressive disclosure trades the model's *up-front visibility* of the full tool
set for token savings (per Vercel/chrlschn, partial schemas can lower accuracy),
and adds a discovery round-trip. Mitigations: `search_tools` returns full schemas
for matches; ship a lightweight name+one-liner index so the model knows what
*exists*.

## Spec note
The MCP spec does not yet provide this natively — SEP-1649 (MCP Server Cards) is
adjacent (HTTP discovery / static-vs-dynamic tools) but not a tool-search/lazy
mechanism, and it's a draft. So this must be built server-side (or via a gateway),
not waited for.

## References
- solo.io — MCP progressive disclosure (`get_tool`/`invoke_tool` facade)
- anything-llm `toolReranker.js` — embedding rerank, top-N (client-side)
- chrlschn — "MCP is dead, long live MCP" (argues for full schemas up front)
- MCP SEP-1649 — Server Cards
