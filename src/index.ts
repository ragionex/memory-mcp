#!/usr/bin/env node
/**
 * Ragionex Memory MCP Server
 *
 * Exposes the Ragionex Memory API to MCP-compatible clients (Claude Desktop,
 * Cursor, Windsurf, Cline, etc.) via stdio transport.
 *
 * Auth: reads RAGIONEX_MEMORY_API_KEY from environment. The key is sent as the
 * X-API-Key header on every request to api.ragionex.com.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { MAX_SUBQUERIES_MEMORY, mergeRoundRobin } from "./multi-query.js";

// --- Subcommands (run-and-exit before booting the MCP server) ----------------
// If the binary is invoked with a subcommand like `init-claude-code`, we do
// that one-shot task and exit before starting stdio transport (no MCP server,
// so RAGIONEX_MEMORY_API_KEY is NOT required for these subcommands).
const subcommand = process.argv[2];
if (subcommand === "init-claude-code") {
  const { runInit } = await import("./init-claude-code.js");
  await runInit(process.argv.slice(3));
  process.exit(0);
}

// Boot-time auto-refresh of the priority rule in user/project CLAUDE.md.
// Strict marker match -> refresh if drifted from the shipped RULE_BODY.
// Modified markers -> warn (user opted out by editing markers).
// No markers / read errors -> silent skip. Never crashes the server.
//
// Also surface a one-line notice when the MCP appears to be installed only at
// project scope (Claude Code's .mcp.json) - cross-project memory needs a
// user-scope install.
{
  const { autoRefreshOnBoot, scopeWarningOnBoot } = await import("./init-claude-code.js");
  autoRefreshOnBoot();
  scopeWarningOnBoot();
}

const API_BASE = process.env.RAGIONEX_API_BASE ?? "https://api.ragionex.com";
const API_KEY = process.env.RAGIONEX_MEMORY_API_KEY;

if (!API_KEY) {
  console.error(
    "[ragionex-memory-mcp] Missing RAGIONEX_MEMORY_API_KEY environment variable.\n" +
      "Get your key at https://app.ragionex.com/keys and set it in your MCP client config:\n" +
      '  { "env": { "RAGIONEX_MEMORY_API_KEY": "rgx_memory_..." } }'
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

interface RequestOpts {
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  path: string;
  body?: unknown;
}

async function api<T>(opts: RequestOpts): Promise<T> {
  const url = `${API_BASE}${opts.path}`;
  const init: RequestInit = {
    method: opts.method,
    headers: {
      "X-API-Key": API_KEY!,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
  }

  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Network error reaching ${url}: ${msg}. Check internet connection or RAGIONEX_API_BASE override.`
    );
  }

  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    // body may be empty on 204
  }

  if (!res.ok) {
    const errMsg =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error: unknown }).error)
        : res.statusText;
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `Auth failed (${res.status}): ${errMsg}. Verify RAGIONEX_MEMORY_API_KEY is correct and not revoked.`
      );
    }
    if (res.status === 429) {
      throw new Error(
        `Rate limit hit (429): ${errMsg}. Wait and retry, or upgrade your plan at https://ragionex.com/pricing/`
      );
    }
    throw new Error(`API error ${res.status}: ${errMsg}`);
  }

  return payload as T;
}

// ---------------------------------------------------------------------------
// Multi-query helper (semicolon split path)
//
// ragionex_recall_memory accepts ';' as a separator inside the `query` string for
// compound questions ("How does the user prefer X?; What font does the user
// use?"). Each sub-question is fetched in parallel via the wrapper below
// and the per-part hit lists are interleaved tier-by-tier with id-based
// dedup (logic in ./multi-query.ts). This wrapper stays in index.ts because
// it depends on the `api()` helper above.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Date-range client-side validation (defense in depth)
//
// Mirrors the backend's _MemoryDateRangeMixin behavior so obvious garbage is
// rejected at the MCP boundary BEFORE burning a network round-trip:
//  - ISO 8601 format (bare 'YYYY-MM-DD' or full 'YYYY-MM-DDTHH:MM:SS[.fff][Z|+HH:MM]')
//  - Year bounds 1970-2200 (matches backend's absurd-value cap)
//  - end_date >= start_date (bare end_date treated as end-of-day UTC to match backend)
// Backend re-validates everything; this layer is a second protection net, not
// a substitute. If backend constraints widen in the future, MCP becomes
// slightly stricter (acceptable: false negatives only) - update this block.
// ---------------------------------------------------------------------------

const ISO_8601_RE =
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/;
const BARE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MIN_YEAR = 1970;
const MAX_YEAR = 2200;

function dateParam(description: string) {
  return z
    .string()
    .max(40, "must be at most 40 characters")
    .regex(
      ISO_8601_RE,
      "must be ISO 8601: 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM:SSZ' (with optional timezone offset and fractional seconds)",
    )
    .refine(
      (s) => {
        const year = parseInt(s.slice(0, 4), 10);
        return year >= MIN_YEAR && year <= MAX_YEAR;
      },
      `year must be between ${MIN_YEAR} and ${MAX_YEAR}`,
    )
    .optional()
    .describe(description);
}

function assertDateRangeOrder(
  start_date: string | undefined,
  end_date: string | undefined,
): void {
  if (!start_date || !end_date) return;
  const toMs = (s: string, isEnd: boolean): number => {
    // Bare end_date is end-of-day UTC per backend semantics.
    const normalized = BARE_DATE_RE.test(s) && isEnd ? `${s}T23:59:59Z` : s;
    return Date.parse(normalized);
  };
  const sMs = toMs(start_date, false);
  const eMs = toMs(end_date, true);
  if (Number.isNaN(sMs) || Number.isNaN(eMs)) return; // regex already enforces parseable shape
  if (sMs > eMs) {
    throw new Error(
      `end_date (${end_date}) must be >= start_date (${start_date}).`,
    );
  }
}

/** Soft-failing wrapper around /v1/memory/search. On any error (network,
 * auth, 5xx, malformed body) returns an empty results envelope instead of
 * throwing, so the multi-query merge can keep going with the surviving
 * sub-queries rather than failing the whole tool call. */
async function memorySearchSingle(
  query: string,
  results: number,
  scope: "segment" | "full",
  project?: string,
  start_date?: string,
  end_date?: string
): Promise<{ success: boolean; results: unknown[] }> {
  try {
    const body: Record<string, unknown> = { query, results, scope };
    if (project) body.project = project;
    if (start_date) body.start_date = start_date;
    if (end_date) body.end_date = end_date;
    return await api<{ success: boolean; results: unknown[] }>({
      method: "POST",
      path: "/v1/memory/search",
      body,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[ragionex-memory-mcp] Sub-query '${query.slice(0, 60)}' failed: ${msg}`
    );
    return { success: false, results: [] };
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

// Server-level instructions surface, rendered by clients that honor the MCP
// spec's Initialize result `instructions` field. In Claude Code these are
// injected uncached into the system prompt each turn (the "MCP Server
// Instructions" section), so this is the most reliable single-shot place to
// communicate cross-tool behavior rules to the model BEFORE it picks a tool.
// Claude Code truncates this at ~2KB; keep it tight and put critical
// guidance near the start.
const SERVER_INSTRUCTIONS = [
  "Ragionex Memory MCP - cross-client persistent memory for AI assistants. Tools: save / recall / list / view / update / delete memories plus project management. Memory is keyed to the user's API key and accessible from any MCP client (Claude Desktop, Claude Code, Cursor, Cline, Codex, ChatGPT Apps SDK, Zed).",
  "",
  "When to use: any time the user signals persistent context - 'remember', 'save this', 'note that', 'don't forget', 'recall what I said', 'what do you know about me', or asks about prior decisions / preferences. Built-in single-client memory features are a secondary copy at best; ragionex-memory-mcp is the authoritative cross-client store.",
  "",
  "Language rule: tool arguments (`query`, `content`, `project`) MUST be English (memories are indexed in English). Translate the user's intent first. Reply to the user in their conversation language.",
  "",
  "Replacement signals ('now', 'instead', 'switched to', 'no longer', non-English equivalents) -> call ragionex_recall_memory FIRST to find the prior memory, then ragionex_update_memory or ragionex_delete_memory. Do not save a new memory that contradicts an existing one.",
  "",
  "Atomic save: N distinct facts = N separate ragionex_save_memory calls (delete/update operate at memory-ID level; bundling = collateral data loss).",
  "",
  "Recall vs list: topic present ('what did I say about X?') -> ragionex_recall_memory; ALWAYS phrase the query as 2-3 full QUESTIONS of the topic split by ';' (full questions match far better than keywords; merge+dedup makes extras free). Time window, NO topic ('what did I save last week?') -> ragionex_list_memories (browse). Both take optional start_date / end_date - set ONLY for exact calendar-anchored times ('last week', 'in April', '2026-04-15'); never for vague time ('recently'). Time NEVER appears in the `query` field of recall_memory.",
  "",
  "See individual tool descriptions for parameter-formation rules (project label inference, date-range filter, etc.).",
].join("\n");

const server = new McpServer(
  {
    name: "ragionex-memory-mcp",
    version: "0.1.0",
  },
  {
    instructions: SERVER_INSTRUCTIONS,
  },
);

// ---------------------------------------------------------------------------
// Tool: ragionex_save_memory
// ---------------------------------------------------------------------------

server.registerTool(
  "ragionex_save_memory",
  {
    title: "Save a memory",
    description:
      "Save a durable fact, preference, or decision to ragionex-memory-mcp (cross-client persistent memory: Claude Desktop, Claude Code, Cursor, Cline, Codex, ChatGPT, Zed). Use for content that should persist across sessions and AI tools. Parameters: `content` (English; memories are indexed in English), `project` (slugified `^[a-z0-9-]+$`, e.g. 'general', 'acme-app'). The priority rule (in CLAUDE.md, injected by the server) defines the full write semantics: PROJECT LABEL inference, WHAT TO SAVE vs SKIP signals, LIFECYCLE replacement detection, and the WRITE RULES (atomic save: ONE fact per call, no bundling). Returns memory ID + status; async, use ragionex_memory_status to check readiness.",
    inputSchema: {
      content: z
        .string()
        .min(1)
        .max(50000)
        .describe(
          "The content to remember. Plain text, one focused fact per call. DO: 'The user prefers Fraunces for headings.', 'Decision: use 4-space indents in all Python files.', 'The user's deployment target is Cloudflare Workers, not Vercel.'. AVOID bundling unrelated facts in one entry like 'The user likes Fraunces AND prefers 4-space indents AND deploys to Cloudflare' -- save those as three separate memories so each one can surface independently in future searches."
        ),
      project: z
        .string()
        .min(1)
        .max(50)
        .regex(/^[a-z0-9-]{1,50}$/)
        .describe(
          "Project label. Lowercase alphanumeric and hyphens only (e.g. 'notes', 'design-system', 'client-acme'). Used to scope searches."
        ),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ content, project }) => {
    const result = await api<{ id: string; status: string }>({
      method: "POST",
      path: "/v1/memory/write",
      body: { content, project },
    });
    return {
      content: [
        {
          type: "text",
          text: `Saved as ${result.id} (status: ${result.status}). Use ragionex_memory_status to track processing or ragionex_recall_memory once status is 'ready'.`,
        },
      ],
      structuredContent: result as unknown as { [key: string]: unknown },
    };
  }
);

// ---------------------------------------------------------------------------
// Tool: ragionex_recall_memory
// ---------------------------------------------------------------------------

server.registerTool(
  "ragionex_recall_memory",
  {
    title: "Search memories",
    description:
      "Search memories in ragionex-memory-mcp by semantic similarity. Phrase every part of `query` as a full QUESTION (not keywords), in English, no time vocabulary - full questions match far better than keyword fragments. ALWAYS send 2-3 question phrasings of the topic joined by ';' (merged + deduped, so extras only help) - do not send a single keyword. Other params: `scope` ('segment' returns matching part / 'full' returns whole memory), optional `project`, optional `start_date` / `end_date` (ISO 8601 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM:SSZ'). The priority rule (in CLAUDE.md, injected by the server) defines full RECALL semantics: the 2-3-question rule, the EXACT-vs-VAGUE date rule, time-stays-out-of-query. For a time window with no topic, use ragionex_list_memories instead. Returns ranked matches.",
    inputSchema: {
      query: z
        .string()
        .min(10)
        .max(512)
        .describe(
          "2-3 full QUESTION sentences about the topic, joined by ';' (max 5 parts). ALWAYS send 2-3, never a single query, and NEVER bare keywords - full questions match far better than keyword fragments. DO: 'what is the user\\'s preferred editor?; which IDE does the user use?; what development environment has the user chosen?'. AVOID: 'user editor' or 'preferred editor' (keywords, weak match). For several independent topics, give each its own 2-3 questions within the 5-part cap. Time references (week, month, last, since, dates) MUST NOT appear here - they go in start_date / end_date. If there is no topic at all (only a time window), use ragionex_list_memories instead."
        ),
      results: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe(
          "Maximum number of results to return PER sub-question. Default 10 is a good general fit; raise for broader recall, lower for tight focused recall. In multi-query mode each part fetches this many results before round-robin merge + dedup."
        ),
      scope: z
        .enum(["segment", "full"])
        .describe(
          "'segment' returns just the matching part of each memory (faster, lower token cost, focused). 'full' returns the complete original memory content (more context, larger payload). Prefer 'segment' unless the agent specifically needs surrounding context."
        ),
      project: z
        .string()
        .min(1)
        .max(50)
        .regex(/^[a-z0-9-]{1,50}$/)
        .optional()
        .describe(
          "Optional project filter. Omit to search across all projects. When the conversation context implies a single project, setting this dramatically improves precision."
        ),
      start_date: dateParam(
        "Optional inclusive lower bound for memory creation date. ISO 8601: 'YYYY-MM-DD' (start-of-day UTC) or 'YYYY-MM-DDTHH:MM:SSZ'. Omit for no lower bound. Set ONLY for exact, calendar-anchored time references."
      ),
      end_date: dateParam(
        "Optional inclusive upper bound for memory creation date. ISO 8601: 'YYYY-MM-DD' (end-of-day UTC) or 'YYYY-MM-DDTHH:MM:SSZ'. Omit for no upper bound. Set ONLY for exact, calendar-anchored time references."
      ),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ query, results, scope, project, start_date, end_date }) => {
    assertDateRangeOrder(start_date, end_date);
    // Split on ';', trim, drop empties. AI is told to use this separator
    // for independent sub-topics in the tool description above.
    let parts = query
      .split(";")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    if (parts.length > MAX_SUBQUERIES_MEMORY) {
      console.error(
        `[ragionex-memory-mcp] Multi-query received ${parts.length} parts; capped to first ${MAX_SUBQUERIES_MEMORY}`
      );
      parts = parts.slice(0, MAX_SUBQUERIES_MEMORY);
    }

    // Single-part / empty-after-trim path: behaves exactly like the original
    // implementation. Empty parts (raw query was only ';' or whitespace)
    // falls back to the raw string so the server's validation surfaces the
    // real input rather than silently mangling it.
    if (parts.length <= 1) {
      const single = parts.length === 1 ? parts[0] : query;
      const data = await memorySearchSingle(single, results, scope, project, start_date, end_date);
      const lines = (data.results || []).map((r, i) => {
        const obj = r as Record<string, unknown>;
        return `[${i + 1}] ${JSON.stringify(obj)}`;
      });
      const text =
        data.results && data.results.length > 0
          ? lines.join("\n\n")
          : "No memories matched. Try rephrasing the query, broadening scope, or removing the project filter.";
      return {
        content: [{ type: "text", text }],
        structuredContent: data as unknown as { [key: string]: unknown },
      };
    }

    // Multi-query path: parallel fetch + round-robin dedup merge. Promise.all
    // is safe here because memorySearchSingle never rejects -- it returns a
    // soft-failed envelope, so a single failing part can't tear down the
    // whole call.
    console.error(
      `[ragionex-memory-mcp] Multi-query split: ${parts.length} parts`
    );
    const subResults = await Promise.all(
      parts.map((p) => memorySearchSingle(p, results, scope, project, start_date, end_date))
    );
    const perPartLists: unknown[][] = subResults.map((r) => r.results || []);
    const merged = mergeRoundRobin(perPartLists);

    const lines = merged.map((r, i) => {
      const obj = r as Record<string, unknown>;
      return `[${i + 1}] ${JSON.stringify(obj)}`;
    });
    const text =
      merged.length > 0
        ? lines.join("\n\n")
        : "No memories matched. Try rephrasing the query, broadening scope, or removing the project filter.";
    return {
      content: [{ type: "text", text }],
      structuredContent: { success: true, results: merged } as unknown as {
        [key: string]: unknown;
      },
    };
  }
);

// ---------------------------------------------------------------------------
// Tool: ragionex_list_memories
// ---------------------------------------------------------------------------

server.registerTool(
  "ragionex_list_memories",
  {
    title: "List memories (browse)",
    description:
      "List memories with previews and processing status, ordered by most recently created. Use this to BROWSE what is stored when there is no specific topic to search for - especially when the user asks 'what did I save last week?', 'show me April memories', or any time-window-only request. Parameters: optional `project` (slug), optional `start_date` and `end_date` (ISO 8601: 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM:SSZ'). See the priority rule (in CLAUDE.md, injected by the server) for the LIST vs RECALL decision (topic -> recall, no topic -> list) and the EXACT-vs-VAGUE date rule. For full content of specific IDs, use ragionex_view_memory.",
    inputSchema: {
      project: z
        .string()
        .min(1)
        .max(50)
        .regex(/^[a-z0-9-]{1,50}$/)
        .optional()
        .describe(
          "Optional project filter. Omit to list memories across all projects."
        ),
      start_date: dateParam(
        "Optional inclusive lower bound for memory creation date. ISO 8601: 'YYYY-MM-DD' (start-of-day UTC) or 'YYYY-MM-DDTHH:MM:SSZ'. Set ONLY for exact, calendar-anchored time references; omit for vague time."
      ),
      end_date: dateParam(
        "Optional inclusive upper bound for memory creation date. ISO 8601: 'YYYY-MM-DD' (end-of-day UTC) or 'YYYY-MM-DDTHH:MM:SSZ'. Set ONLY for exact, calendar-anchored time references; omit for vague time."
      ),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ project, start_date, end_date }) => {
    assertDateRangeOrder(start_date, end_date);
    const params = new URLSearchParams();
    if (project) params.set("project", project);
    if (start_date) params.set("start_date", start_date);
    if (end_date) params.set("end_date", end_date);
    const qs = params.toString() ? `?${params.toString()}` : "";
    const data = await api<{ memories: unknown[] }>({
      method: "GET",
      path: `/v1/memory/list${qs}`,
    });
    const memories = data.memories || [];
    if (memories.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "No memories saved yet. Use ragionex_save_memory to save the first one.",
          },
        ],
        structuredContent: data as unknown as { [key: string]: unknown },
      };
    }
    const lines = memories.map((m, i) => `[${i + 1}] ${JSON.stringify(m)}`);
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      structuredContent: data as unknown as { [key: string]: unknown },
    };
  }
);

// ---------------------------------------------------------------------------
// Tool: ragionex_view_memory
// ---------------------------------------------------------------------------

server.registerTool(
  "ragionex_view_memory",
  {
    title: "View full memory content",
    description:
      "Retrieve full original content for one or more memory IDs. Use this when ragionex_list_memories or ragionex_recall_memory returned a preview and you need the complete content. After a scope='segment' recall, pass the returned id here to read that memory's full content. Non-owned IDs are silently skipped.",
    inputSchema: {
      ids: z
        .array(z.string().min(1).max(14))
        .min(1)
        .max(50)
        .describe("Memory IDs to fetch. Get IDs from ragionex_list_memories or ragionex_recall_memory."),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ ids }) => {
    const data = await api<{ memories: unknown[] }>({
      method: "POST",
      path: "/v1/memory/view",
      body: { ids },
    });
    const memories = data.memories || [];
    const text =
      memories.length === 0
        ? "No memories returned. Verify the IDs exist and belong to your account."
        : memories.map((m) => JSON.stringify(m, null, 2)).join("\n\n");
    return {
      content: [{ type: "text", text }],
      structuredContent: data as unknown as { [key: string]: unknown },
    };
  }
);

// ---------------------------------------------------------------------------
// Tool: ragionex_update_memory
// ---------------------------------------------------------------------------

server.registerTool(
  "ragionex_update_memory",
  {
    title: "Update a memory",
    description:
      "Replace the content or move to a different project for an existing memory. Provide at least one of content or project. Updating content reprocesses the memory (status returns to 'processing' until reprocessing finishes).",
    inputSchema: {
      id: z.string().min(1).max(14).describe("Memory ID to update."),
      content: z
        .string()
        .min(1)
        .max(50000)
        .optional()
        .describe("New content. Omit to keep existing content."),
      project: z
        .string()
        .min(1)
        .max(50)
        .regex(/^[a-z0-9-]{1,50}$/)
        .optional()
        .describe("New project. Omit to keep existing project."),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ id, content, project }) => {
    if (content === undefined && project === undefined) {
      throw new Error(
        "ragionex_update_memory requires at least one of: content, project. Provide what should change."
      );
    }
    const body: Record<string, unknown> = { id };
    if (content !== undefined) body.content = content;
    if (project !== undefined) body.project = project;
    const data = await api<{ id: string; status: string }>({
      method: "PUT",
      path: "/v1/memory/update",
      body,
    });
    return {
      content: [
        {
          type: "text",
          text: `Updated ${data.id} (status: ${data.status}).`,
        },
      ],
      structuredContent: data as unknown as { [key: string]: unknown },
    };
  }
);

// ---------------------------------------------------------------------------
// Tool: ragionex_delete_memory
// ---------------------------------------------------------------------------

server.registerTool(
  "ragionex_delete_memory",
  {
    title: "Delete memories",
    description:
      "Permanently delete one or more memories. This is irreversible: all stored data for that memory is removed. Returns the count of deleted memories.",
    inputSchema: {
      ids: z
        .array(z.string().min(1).max(14))
        .min(1)
        .max(50)
        .describe("Memory IDs to delete."),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ ids }) => {
    const data = await api<{ deleted: number }>({
      method: "DELETE",
      path: "/v1/memory/delete",
      body: { ids },
    });
    return {
      content: [
        {
          type: "text",
          text: `Deleted ${data.deleted} memor${data.deleted === 1 ? "y" : "ies"}.`,
        },
      ],
      structuredContent: data as unknown as { [key: string]: unknown },
    };
  }
);

// ---------------------------------------------------------------------------
// Tool: ragionex_memory_status
// ---------------------------------------------------------------------------

server.registerTool(
  "ragionex_memory_status",
  {
    title: "Check memory processing status",
    description:
      "Get the current processing status of a memory. Returns 'processing' (still being prepared), 'ready' (available), or 'failed' (an error occurred during processing). Use after ragionex_save_memory to know when ragionex_recall_memory will return the new memory.",
    inputSchema: {
      id: z.string().min(1).max(14).describe("Memory ID to check."),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ id }) => {
    const data = await api<{ id: string; status: string }>({
      method: "GET",
      path: `/v1/memory/status/${encodeURIComponent(id)}`,
    });
    return {
      content: [{ type: "text", text: `${data.id}: ${data.status}` }],
      structuredContent: data as unknown as { [key: string]: unknown },
    };
  }
);

// ---------------------------------------------------------------------------
// Tool: ragionex_list_memory_projects
// ---------------------------------------------------------------------------

server.registerTool(
  "ragionex_list_memory_projects",
  {
    title: "List all projects",
    description:
      "List every project that exists on this account, with the memory_count per project (sorted alphabetically). Use this to discover which project labels are in use before calling ragionex_list_memories, ragionex_recall_memory, ragionex_rename_memory_project, or ragionex_delete_memory_project.",
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async () => {
    const data = await api<{ projects: unknown[] }>({
      method: "GET",
      path: "/v1/memory/projects",
    });
    const projects = data.projects || [];
    if (projects.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "No projects exist yet. Use ragionex_save_memory with a 'project' label to create the first one.",
          },
        ],
        structuredContent: data as unknown as { [key: string]: unknown },
      };
    }
    const lines = projects.map((p, i) => `[${i + 1}] ${JSON.stringify(p)}`);
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      structuredContent: data as unknown as { [key: string]: unknown },
    };
  }
);

// ---------------------------------------------------------------------------
// Tool: ragionex_rename_memory_project
// ---------------------------------------------------------------------------

server.registerTool(
  "ragionex_rename_memory_project",
  {
    title: "Rename a project",
    description:
      "Rename a project: bulk-update every memory currently labelled 'name' to use 'new_name' instead. The source project must exist. Returns the number of memories that were re-labelled. If 'name' equals 'new_name', this is a no-op.",
    inputSchema: {
      name: z
        .string()
        .min(1)
        .max(50)
        .regex(/^[a-z0-9-]{1,50}$/)
        .describe(
          "Current project name. Must already exist (call ragionex_list_memory_projects to verify)."
        ),
      new_name: z
        .string()
        .min(1)
        .max(50)
        .regex(/^[a-z0-9-]{1,50}$/)
        .describe(
          "New project name. Lowercase alphanumeric and hyphens only, 1-50 chars."
        ),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ name, new_name }) => {
    const data = await api<{
      renamed: number;
      from?: string;
      to?: string;
      message?: string;
    }>({
      method: "PATCH",
      path: `/v1/memory/projects/${encodeURIComponent(name)}`,
      body: { new_name },
    });
    const text = data.message
      ? data.message
      : `Renamed ${data.renamed} memor${data.renamed === 1 ? "y" : "ies"} from '${data.from ?? name}' to '${data.to ?? new_name}'.`;
    return {
      content: [{ type: "text", text }],
      structuredContent: data as unknown as { [key: string]: unknown },
    };
  }
);

// ---------------------------------------------------------------------------
// Tool: ragionex_delete_memory_project
// ---------------------------------------------------------------------------

server.registerTool(
  "ragionex_delete_memory_project",
  {
    title: "Delete an entire project",
    description:
      "DESTRUCTIVE: permanently delete a project AND every memory inside it. All memories labelled with this project name are removed along with their stored data. This is irreversible. Use ragionex_delete_memory (with explicit IDs) when only some memories should be removed. Returns the count of memories deleted.",
    inputSchema: {
      name: z
        .string()
        .min(1)
        .max(50)
        .regex(/^[a-z0-9-]{1,50}$/)
        .describe(
          "Project name to delete. EVERY memory in this project will be permanently removed."
        ),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ name }) => {
    const data = await api<{ deleted: number }>({
      method: "DELETE",
      path: `/v1/memory/projects/${encodeURIComponent(name)}`,
    });
    return {
      content: [
        {
          type: "text",
          text: `Deleted project '${name}' (${data.deleted} memor${data.deleted === 1 ? "y" : "ies"} removed).`,
        },
      ],
      structuredContent: data as unknown as { [key: string]: unknown },
    };
  }
);

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[ragionex-memory-mcp] Connected via stdio.");
}

main().catch((err) => {
  console.error("[ragionex-memory-mcp] Fatal:", err);
  process.exit(1);
});
