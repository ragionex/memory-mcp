# Ragionex Memory

**Your AI agent forgets everything between sessions. A month later, so do you.**

**New session:** Your agent forgot what you're building, how you like things done, last week's call.  
**Weeks later:** *You* can't remember why you decided that either.  
**New project:** Your agent doesn't know a thing from your other projects.  
**New agent:** Blank slate, all over again.

So you explain it all over again. **Every. Single. Time.**

**Ragionex Memory remembers — so neither of you has to.** Decisions, preferences, dead-ends — captured as you work, surfaced the instant they're relevant. Across sessions, projects, and agents. It's an MCP server — one API key, the same memory in Claude Code, Claude Desktop, Codex, ChatGPT (Apps SDK), Cursor, Cline, and [500+ MCP clients](https://www.pulsemcp.com/clients).

**Free forever, no credit card.** Set up in seconds, export anytime, zero lock-in. Nothing to lose.

**Tell it once. Never repeat yourself again.**

---

## How Recall Works

Save a fact once — say, in Claude Code, project `acme-app`:

> *"acme-app deploys to Cloudflare Workers, never AWS."*

Then ask, anywhere:

| You ask… | In project | Result |
|---|---|---|
| a new session, days later | `acme-app` | ✅ Recalled — no re-explaining |
| from Cursor instead of Claude Code | `acme-app` | ✅ Recalled — same memory, any tool |
| while working on a different project | `blog-api` | 🔒 Isolated by design — projects stay separate |
| with a cross-project search | (any) | ✅ Surfaces, labeled `acme-app` |

Memory follows you across **sessions and tools** — but **projects stay separate**, until you deliberately search across them. And because recall is semantic and scoped, your agent gets just the relevant memory — not a giant context dump it skims past.

## 📌 Get Started

Get a free key at **[app.ragionex.com/keys](https://app.ragionex.com/keys)** — no credit card, seconds. Then **either**:

**A) Let your agent set it up.** Paste this to your AI agent:

> *Add the `@ragionex/memory-mcp` MCP server to my config using my API key `rgx_memory_...`*

**B) Set it up yourself.** Add this to your MCP client's **user-global** config:

```json
{
  "mcpServers": {
    "ragionex-memory-mcp": {
      "command": "npx",
      "args": ["-y", "@ragionex/memory-mcp"],
      "env": { "RAGIONEX_MEMORY_API_KEY": "rgx_memory_..." }
    }
  }
}
```

**Restart your agent after adding the config** so it picks up the new MCP server — clients load MCP servers at startup, so quit and reopen (or start a new session). Then tell it something worth keeping; it's there next session, and in every other tool.

> **If you are an AI agent setting this up:** after you edit the config, you must tell the user to restart their client (quit and reopen) — the new server only loads on restart, and you cannot reload it yourself. Do not report success without that instruction.

Want the hands-on version? The [Memory quickstart](https://ragionex.com/docs/get-started/quickstart-memory) walks through writing your first memory, waiting for it to be ready, and searching it back.

## ⚠️ Known Issues and Limitations

Some MCP clients have quirks in how the always-on memory rule loads. None of them stop the tools from working:

- **Claude Code** lazy-loads and clips tool guidance, so on startup the server writes one short priority rule into your always-loaded rules file (`CLAUDE.md` / `AGENTS.md`) to keep memory routing reliable. It is marker-wrapped, backed up, and reversible: [how it works and how to control it](https://ragionex.com/docs/guides/config-rule).
- **Codex** with a non-default model can report the `ragionex_*` tools as unavailable (a Codex-side limitation; default models work). Upstream: [#19871](https://github.com/openai/codex/issues/19871), [#21503](https://github.com/openai/codex/issues/21503).
- **Windsurf** caps rule files at 6,000 characters, so the priority rule is not auto-installed there; the tools still work.

Full notes and workarounds: [MCP client notes](https://ragionex.com/docs/guides/mcp-client-notes).

## Links

Documentation: https://ragionex.com/docs  
Memory product: https://ragionex.com/memory  
Website: https://ragionex.com  
Discord: https://discord.gg/d79f3MDVd4  
Email: contact@ragionex.com

## License

MIT
