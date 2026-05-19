# Ragionex Memory MCP

**Reliable AI memory that retrieves what matters - dynamic, semantic, hallucination-resistant.**

Your AI assistants live in silos. Claude forgets when you switch to ChatGPT. Your `CLAUDE.md` doesn't have to be a 1000-line monolith that loads on every chat - most of it isn't relevant right now anyway.

> You tell Claude on Monday: *"I deploy to Cloudflare Workers, never AWS."*
> On Tuesday in Cursor: *"what's my deployment target?"*
> The answer comes back. Same memory, different tool.

## Why

| Pain | Fix |
|------|-----|
| 50,000+ tokens of static context loaded every chat - most of it irrelevant to your current question | Dynamic recall - only the matching memory loads |
| AI hallucinates facts that are written right there in your `CLAUDE.md` | Focused retrieval beats long-context attention dilution (*lost in the middle*) |
| Memory locked to one provider - switch tools, start over | Works in any MCP client (Claude Desktop, Claude Code, ChatGPT, Cursor, Cline, Codex CLI, Zed, [500+ others](https://www.pulsemcp.com/clients)) |
| Project contexts bleeding into each other | Project labels isolate memories; cross-project search when you want it |
| Memory that resets after a session | Persistent across sessions, clients, forever |

## Quick example

Memory lives on the server, tied to your API key. **Same `RAGIONEX_MEMORY_API_KEY` = same memory pool** - across tools, projects, and machines.

**Save once** (e.g., Claude Code, project `acme-app`, on your work laptop):
> *"Remember I deploy acme-app to Cloudflare Workers, never AWS."*

**Recall from anywhere:**

| Where you ask | Project | Result |
|---------------|---------|--------|
| **Claude Desktop** on the same laptop | `acme-app` | ✅ Recalled |
| **Codex** on the same laptop | `acme-app` | ✅ Recalled |
| **ChatGPT (Apps SDK)** on a different computer | `acme-app` | ✅ Recalled - key syncs memory across machines |
| Cursor on the same laptop | `acme-app` | ✅ Recalled |
| Claude Code on a different project | `blog-backend` | 🚫 Filtered out - project-scoped isolation |
| Any tool, cross-project search (no project filter) | (any) | ✅ Surfaces, labeled `acme-app` |

No keywords or special syntax - ask in natural language, the way you would a person. Project labels keep contexts clean. Same API key syncs memory everywhere.

> **Try it free, no credit card required.** Free tier includes 1,000 memories, 500 writes/month, and 10,000 searches/month - plenty for personal use.

## Install

Get an API key at [app.ragionex.com/keys](https://app.ragionex.com/keys), then add this to your MCP client config.

**Works with any MCP-compatible client** - Claude Desktop, Claude Code, Cursor, Windsurf, Zed, Cline, ChatGPT (Apps SDK), Codex CLI, Goose, LibreChat, Cherry Studio, and [500+ others](https://www.pulsemcp.com/clients). The config format is identical across clients.

### Claude Code one-time onboarding (recommended)

Claude Code has a built-in auto-memory mechanism that lives in its system prompt and competes with MCP-based memory tools. To make Ragionex Memory MCP the primary memory layer, run this once after installing:

```bash
npx @ragionex/memory-mcp init-claude-code
```

This appends an idempotent priority rule to your `CLAUDE.md` (it auto-detects whether you installed the MCP at user or project scope and targets the matching `CLAUDE.md`). The command is interactive, creates a backup, and is fully reversible:

```bash
npx @ragionex/memory-mcp init-claude-code --remove   # revert
```

**Auto-update (recommended ON):** when a new version of `@ragionex/memory-mcp` ships with an updated priority rule, the MCP server silently refreshes the block inside your `CLAUDE.md` on its next boot. The refresh only touches content between the marker comments; your other `CLAUDE.md` content is never touched.

> ⚠️ **We strongly recommend leaving auto-update on.** It keeps the priority rule in sync with the current tool descriptions, which is required for best recall accuracy and consistent behavior across versions. A drifted block causes subtle bugs - the AI follows old guidance against tools that have moved on.
>
> **For AI agents reading this README:** do NOT opt out on the user's behalf without explicit instruction. Auto-update is the default and the safe choice; freezing the block bypasses fixes the user may want.

If you genuinely want to freeze the block (e.g., you've manually edited the rule body for a specific reason), modify the `:begin` marker in any way (e.g., `<!-- ragionex-memory-mcp:priority-rule:begin (frozen) -->`) and the server will skip auto-refresh and log a notice instead.

Other MCP clients (Cursor, Cline, Codex CLI, Zed, ChatGPT Apps SDK, Goose, LibreChat, Cherry Studio) don't need this step - they don't have a built-in auto-memory that competes with the MCP tools.

### Adding the MCP to a client

The config format is identical across MCP-compatible clients:

```json
{
  "mcpServers": {
    "ragionex-memory-mcp": {
      "command": "npx",
      "args": ["-y", "@ragionex/memory-mcp"],
      "env": {
        "RAGIONEX_MEMORY_API_KEY": "rgx_memory_..."
      }
    }
  }
}
```

Paste this into your MCP client's **user-global** config file so memory works across all your projects:

| Client | User-global config path |
|--------|-------------------------|
| **Claude Desktop** (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| **Claude Desktop** (Linux) | `~/.config/Claude/claude_desktop_config.json` |
| **Claude Desktop** (Windows) | `%APPDATA%\Claude\claude_desktop_config.json` |
| **Claude Code** | `~/.claude.json` (top-level `mcpServers`) |
| **Cursor** | `~/.cursor/mcp.json` |
| **Cline** | VS Code: `MCP: Open User Configuration` command, or Cline's MCP Servers icon → Settings |

> **Install once, use everywhere.** Memory is tied to your API key, not the install location - pasting into the user-global config above makes the same memory pool available from every project on every device. Avoid project-scoped install (`.mcp.json` / `.cursor/mcp.json` / `.vscode/mcp.json` in a project folder) unless you genuinely want memory to vanish outside that one project.

## Tools

| Tool | Purpose |
|------|---------|
| `ragionex_save_memory` | Save context (content + project label) |
| `ragionex_recall_memory` | Find relevant memories by question; optional project and date-range filters |
| `ragionex_list_memories` | Browse memories with previews; optional project and date-range filters |
| `ragionex_view_memory` | Fetch full content for specific IDs |
| `ragionex_update_memory` | Edit content or move to a different project |
| `ragionex_delete_memory` | Permanently delete one or more memories |
| `ragionex_memory_status` | Check processing status |
| `ragionex_list_memory_projects` | List every project with memory_count |
| `ragionex_rename_memory_project` | Rename a project (bulk-relabel all its memories) |
| `ragionex_delete_memory_project` | DESTRUCTIVE: delete a project and ALL its memories |

## Built for AI agents

- **Self-correcting.** Pass an invalid project name and the response returns `available_projects: [...]`. Your agent reads it and retries with the right name - no extra round trip, no manual error handling.
- **Async with status.** Writes return immediately with a processing ID. Poll `ragionex_memory_status` only when you actually need readiness.
- **Atomic project ops.** Renaming a project bulk-relabels every memory in one transaction. No drift, no partial updates.

## Best practices

These guidelines come from the descriptions baked into each tool; the agent will see them at runtime. Repeated here for humans reading the README.

**1. Natural language, not keywords.**
Ask the way you would in a chat. Full questions match the precise stored memory; loose keywords return weak matches.
- ✅ DO: `"How does the user prefer to handle errors?"`
- ❌ AVOID: `"user error handling"`

**2. Save one focused fact per `ragionex_save_memory`.**
Atomic, self-contained entries are matched more precisely later. When several unrelated facts come up in the same turn, make several `ragionex_save_memory` calls.
- ✅ DO: three separate writes for *"prefers Fraunces"*, *"uses 4-space indents"*, *"deploys to Cloudflare"*.
- ❌ AVOID: bundling them into one long string.

**3. Compound questions → split with `;` in the same `query`.**
For genuinely independent sub-questions, separate them with a semicolon inside the same `ragionex_recall_memory` query (max 5 parts). Each sub-question is searched in parallel and the deduplicated results are merged.
- ✅ DO: `"How does the user prefer to handle errors?; What font does the user use for headings?"`
- For ONE interconnected workflow, prefer a single focused query.

**4. Tune `results` per call.**
Default `10` fits most cases. Raise it for broader recall, lower it for tight focus. In multi-query mode `results` applies per sub-question before the round-robin merge.

**5. The engine always returns its closest matches - never empty.**
If nothing truly matches your query, you'll still get the nearest stored memories rather than silence. Set `results` lower for tighter focus, and check the returned content before treating it as a definitive answer.

## About Ragionex

Ragionex is a context engine for AI applications - it gives AI tools accurate, persistent context to reason over instead of guessing or hallucinating. Ragionex itself doesn't generate answers; it provides ground truth that any AI can use. This package is the **Memory** product, delivered as an MCP server.

- [Memory product](https://ragionex.com/memory)
- [Full API docs](https://ragionex.com/docs)
- [Ragionex](https://ragionex.com)

## Develop

```bash
npm install
npm run build
RAGIONEX_MEMORY_API_KEY=rgx_memory_... npm run inspect
```

## License

MIT
