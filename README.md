# Ragionex Memory

**Persistent memory for your AI agents. Tell it once - every session, every project, every tool remembers.**

Your AI agent forgets everything between sessions. A month later, so do you.

- **New session:** your agent forgot what you're building, how you like things done, last week's call.
- **Weeks later:** *you* can't remember why you decided that either.
- **New agent:** blank slate, all over again.

So you explain it all over again. Every. Single. Time.

**Ragionex Memory remembers - so neither of you has to.** Decisions, preferences, dead-ends: captured as you work, surfaced the instant they are relevant. It is an MCP server - one API key, the same memory in Claude Code, Claude Desktop, Codex, ChatGPT (Apps SDK), Cursor, Cline, and [500+ MCP clients](https://www.pulsemcp.com/clients).

And it is honest by design: when nothing matching is saved, it says so. It never fills the gap with a guess.

## How recall works

Save a fact once - say, in Claude Code, project `acme-app`:

> *"acme-app deploys to Cloudflare Workers, never AWS."*

Then ask, anywhere:

| You ask... | In project | Result |
|---|---|---|
| in a new session, days later | `acme-app` | ✅ Recalled - no re-explaining |
| from Cursor instead of Claude Code | `acme-app` | ✅ Recalled - same memory, any tool |
| while working on a different project | `blog-api` | 🔒 Isolated by design - projects stay separate |
| with a cross-project search | (any) | ✅ Surfaces, labeled `acme-app` |

Recall is semantic: ask in your own words, days later, phrased nothing like the original - it still comes back. And it is scoped: your agent gets just the relevant memory, not a context dump it skims past.

## Measured, not promised

Recall quality is the whole product, so we measure it: 203 verified queries against a 3,296-memory corpus built from a pinned public dataset (`microsoft/vscode-docs`), graded with a multi-reference answer key, on the same defaults you get when you install it.

| | |
|---|---|
| **100%** | Found, every time. 203 of 203 - nothing the agent asked for was lost. |
| **96%** | In the top 3 results - right where your agent looks first. |
| **78%** | The very first result, first try. |
| **< 1s** | End-to-end, on a fresh query, searching all 3,296 memories. |

37% of those queries used messy, real-user phrasing rather than clean question form - zero misses there too. Long memories hold up as well: even 41+ sentence entries hit the #1 spot 75% of the time, and every one of them was still found.

## What you're doing instead

| The workaround | Where it breaks |
|---|---|
| Pasting the same context into every new session | You are the memory. It costs you minutes, daily, forever. |
| One giant `CLAUDE.md` / `.cursorrules` file | Grows into a token-hungry monolith the agent skims past. Every rule is in context, always, relevant or not. |
| The vendor's built-in memory | Locked inside one app. Switch tools, start from zero. |

Ragionex flips it: save once, and only the *relevant* memory enters the context, when it is relevant. Sessions change, tools change, projects change - the memory stays.

## 📌 Get started

Get a free key at **[app.ragionex.com/keys](https://app.ragionex.com/keys)** - no credit card, takes seconds. Then **either**:

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

**Restart your agent after adding the config** - clients load MCP servers at startup, so quit and reopen (or start a new session). Then tell it something worth keeping; it is there next session, and in every other tool.

> **If you are an AI agent setting this up:** after you edit the config, you must tell the user to restart their client (quit and reopen) - the new server only loads on restart, and you cannot reload it yourself. Do not report success without that instruction.

Want the hands-on version? The [Memory quickstart](https://ragionex.com/docs/get-started/quickstart-memory) walks through writing your first memory, waiting for it to be ready, and searching it back.

## Free. Actually free.

**10,000 saves and recalls, every month.** No credit card. No trial clock. Export anytime, delete anytime, zero lock-in. If it does not earn its place in your setup, leaving costs you nothing.

## ⚠️ Known issues and limitations

Some MCP clients have quirks in how the always-on memory rule loads. None of them stop the tools from working:

- **Claude Code** lazy-loads and clips tool guidance, so on startup the server writes one short priority rule into your always-loaded rules file (`CLAUDE.md` / `AGENTS.md`) to keep memory routing reliable. It is marker-wrapped, backed up, and reversible: [how it works and how to control it](https://ragionex.com/docs/guides/config-rule).
- **Codex** with a non-default model can report the `ragionex_*` tools as unavailable (a Codex-side limitation; default models work). Upstream: [#19871](https://github.com/openai/codex/issues/19871), [#21503](https://github.com/openai/codex/issues/21503).
- **Windsurf (now Devin Desktop)** caps global rule files at 6,000 characters, so the priority rule is not auto-installed there; the tools still work.

Full notes and workarounds: [MCP client notes](https://ragionex.com/docs/guides/mcp-client-notes).

## Something broken? Tell us.

If anything misbehaves - a failed save, a memory that will not come back, an error that makes no sense - we want to know:

- **Bugs:** [github.com/ragionex/memory-mcp/issues](https://github.com/ragionex/memory-mcp/issues)
- **Questions and community:** [Discord](https://discord.gg/d79f3MDVd4)
- **Private reports:** contact@ragionex.com

## Links

Documentation: https://ragionex.com/docs
Memory product: https://ragionex.com/memory
Website: https://ragionex.com
Discord: https://discord.gg/d79f3MDVd4
Email: contact@ragionex.com

## License

MIT
