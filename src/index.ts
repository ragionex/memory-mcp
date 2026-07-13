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
import {
  configureOfflineQueue,
  enqueuePendingMemory,
  triggerFlush,
} from "./offline-queue.js";

// --- Subcommands (run-and-exit before booting the MCP server) ----------------
// `init` installs/refreshes the priority rule into every detected agent's global
// rules file and exits before starting the stdio transport (no MCP server, so
// RAGIONEX_MEMORY_API_KEY is NOT required for this subcommand).
const subcommand = process.argv[2];
if (subcommand === "init") {
  const { runInit } = await import("./init.js");
  await runInit(process.argv.slice(3));
  process.exit(0);
}

// Boot-time cross-agent priority-rule sync. For each installed + enabled agent,
// ensures its global rules file holds the current rule block (create / refresh /
// skip-if-user-modified-markers). Server-side; best-effort; never crashes boot.
{
  const { autoRefreshOnBoot } = await import("./init.js");
  autoRefreshOnBoot();
}

const API_BASE = process.env.RAGIONEX_API_BASE ?? "https://api.ragionex.com";
const API_KEY = process.env.RAGIONEX_MEMORY_API_KEY;

// Per-request ceiling so a hung connection can never stall a tool call
// forever. Generous on purpose: normal operations finish in well under a
// second, and a false timeout on save would needlessly detour through the
// offline queue.
const REQUEST_TIMEOUT_MS = 30_000;

// Appended ONLY to errors that are the service's fault (5xx, timeouts).
// User-side errors (bad key, quota, validation) must NOT carry it - pointing
// those at the issue tracker buries real bug reports under config mistakes.
const SUPPORT_HINT =
  " If this keeps happening, please report it: https://github.com/ragionex/memory-mcp/issues";

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

/** Error thrown by api(). `status` is the HTTP status code, or undefined for
 * network-level failures (DNS, refused connection, timeout) - callers use it
 * to tell "service unreachable" (no status / 5xx) apart from request errors
 * (4xx). */
class ApiError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
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
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
  }

  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    // Timeout carries no HTTP status, so it lands in the same "unreachable"
    // bucket as DNS/connection failures - saves still detour to the offline
    // queue instead of being lost.
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new ApiError(
        `Request to ${url} timed out after ${REQUEST_TIMEOUT_MS / 1000}s. The service may be down or overloaded - retry shortly.${SUPPORT_HINT}`
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new ApiError(
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
      throw new ApiError(
        `Auth failed (${res.status}): ${errMsg}. Verify RAGIONEX_MEMORY_API_KEY is correct and not revoked.`,
        res.status
      );
    }
    if (res.status === 402) {
      throw new ApiError(`Plan limit reached (402): ${errMsg}`, res.status);
    }
    if (res.status === 429) {
      throw new ApiError(
        `Rate limit hit (429): ${errMsg}. Wait and retry, or upgrade your plan at https://ragionex.com/pricing/`,
        res.status
      );
    }
    throw new ApiError(
      `API error ${res.status}: ${errMsg}${res.status >= 500 ? SUPPORT_HINT : ""}`,
      res.status
    );
  }

  // Service is reachable - opportunistically sync any offline-queued saves
  // (no-op when the queue is empty or a flush is already running).
  triggerFlush();

  return payload as T;
}

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
  "Ragionex Memory MCP - the user's persistent memory across ALL their AI tools. Tools (prefix ragionex_): save / recall / list / view / update / delete memories, memory status, and project management.",
  "",
  "Use on any persistent-context signal: 'remember', 'save this', 'note that', 'recall what I said', 'what do you know about me', or questions about prior decisions/preferences. This store is authoritative; client-local memory is secondary.",
  "",
  "Arguments (query, content, project) always in English; reply in the user's language.",
  "",
  "Replacement signals ('now', 'instead', 'switched to', 'no longer') -> recall FIRST, then update or delete the old memory. Atomic saves: unrelated facts = separate calls; details of one topic stay in one memory.",
  "",
  "Recall: pass 2-3 full question phrasings of the topic as separate `queries` array items - never bare keywords, never time words. No topic, only browsing or a time window -> list_memories. Dates only for exact calendar references ('last week', 'in April'), never vague ('recently').",
  "",
  "On empty recall: retry once without filters; then say it is not saved and offer to save it - never guess.",
  "",
  "Tool descriptions carry parameter details; the priority rule (in the user's rules file) is canonical.",
].join("\n");

const server = new McpServer(
  {
    name: "ragionex-memory-mcp",
    version: "0.5.1",
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
      "Save a durable fact, preference, or decision to ragionex-memory-mcp (cross-client persistent memory: Claude Desktop, Claude Code, Cursor, Cline, Codex, ChatGPT, Zed). Use for content that should persist across sessions and AI tools. Parameters: `content` (English; memories are stored in English), `project` (slugified `^[a-z0-9-]+$`, e.g. 'general', 'acme-app'). The priority rule (in CLAUDE.md, injected by the server) defines the full write semantics: PROJECT LABEL inference, WHAT TO SAVE vs SKIP signals, LIFECYCLE replacement detection, and the WRITE RULES (atomic save: ONE fact per call, no bundling). Returns memory ID + status; async, use ragionex_memory_status to check readiness.",
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
          "Project label, slugified `^[a-z0-9-]+$`. Only two kinds: the current project's folder name (cwd basename) for facts about this codebase, or 'general' for facts about the user or all projects. See the priority rule for details. Do not invent other labels and do not use the full path."
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
    let result: { id: string; status: string };
    try {
      result = await api<{ id: string; status: string }>({
        method: "POST",
        path: "/v1/memory/write",
        body: { content, project },
      });
    } catch (err) {
      // Service unreachable (network error / 5xx): queue the save locally so
      // it is not lost, and say so honestly - the memory is NOT saved yet.
      // Request errors (4xx: validation, quota, auth) are NOT queued; they
      // would fail again identically and the caller must see the real error.
      const unreachable =
        err instanceof ApiError &&
        (err.status === undefined || err.status >= 500);
      if (unreachable) {
        const queued = enqueuePendingMemory({
          content,
          project,
          ts: new Date().toISOString(),
        });
        if (queued) {
          return {
            content: [
              {
                type: "text",
                text: "Memory service unreachable - the memory was queued locally and will sync automatically once the service is reachable again. It is NOT saved yet and will not appear in recall or list results until synced. No action needed.",
              },
            ],
            structuredContent: { queued: true },
          };
        }
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `${msg} The local offline queue is also full or unwritable, so this memory could NOT be queued - retry once connectivity is restored.`
        );
      }
      throw err;
    }
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
      "Search memories in ragionex-memory-mcp by semantic similarity. `queries` is an ARRAY of full QUESTION sentences (English, no time vocabulary) - full questions match far better than keyword fragments. ALWAYS send 2-3 different phrasings of the topic as separate array items (results are merged + deduped server-side, so extras only help) - never a single bare keyword. Other params: optional `project`, optional `start_date` / `end_date` (ISO 8601 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM:SSZ'). The priority rule (in CLAUDE.md, injected by the server) defines full RECALL semantics: the 2-3-question rule, the EXACT-vs-VAGUE date rule, time-stays-out-of-queries. For a time window with no topic, use ragionex_list_memories instead. Returns ranked matches.",
    inputSchema: {
      queries: z
        .array(z.string().min(5).max(512))
        .min(1)
        .max(5)
        .describe(
          "1-5 full QUESTION sentences about the topic, one per array item. ALWAYS send 2-3 phrasings, never a single item, and NEVER bare keywords - full questions match far better than keyword fragments. DO: ['what is the user\\'s preferred editor?', 'which IDE does the user use?', 'what development environment has the user chosen?']. AVOID: ['user editor'] (keywords, weak match). For several independent topics, give each its own 2-3 questions within the 5-item cap. Time references (week, month, last, since, dates) MUST NOT appear here - they go in start_date / end_date. If there is no topic at all (only a time window), use ragionex_list_memories instead."
        ),
      results: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe(
          "Maximum number of results to return, merged across all questions. Default 10 is a good general fit; raise for broader recall, lower for tight focused recall."
        ),
      project: z
        .string()
        .min(1)
        .max(50)
        .regex(/^[a-z0-9-]{1,50}$/)
        .optional()
        .describe(
          "Optional project filter - a precision tool, not a generic narrowing knob (same logic as the date filter). Set it ONLY when the question is explicitly project-scoped: the user names a project, or asks about the current codebase's own code or decisions. For vague, general, or personal questions (the user's preferences, identity, anything spanning projects), OMIT it and search across all projects - an auto-guessed project filter hides relevant matches in 'general' and other projects, exactly like a guessed date range. Never pass 'general' as the filter: it is a save label, not a search scope, and would exclude every other project."
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
  async ({ queries, results, project, start_date, end_date }) => {
    assertDateRangeOrder(start_date, end_date);
    // One request carries every question; the service searches each question
    // and returns a single merged, deduplicated ranking. Errors propagate
    // as-is: a failed request must surface as an ERROR, never as an empty
    // result - otherwise an outage or bad key reads as "the user never
    // saved this".
    const body: Record<string, unknown> = { queries, results };
    if (project) body.project = project;
    if (start_date) body.start_date = start_date;
    if (end_date) body.end_date = end_date;
    const data = await api<{ success: boolean; results: unknown[] } | null>({
      method: "POST",
      path: "/v1/memory/search",
      body,
    });
    if (!data) {
      throw new Error("Empty response body from the memory service.");
    }
    const matches = data.results || [];
    const lines = matches.map((r, i) => {
      const obj = r as Record<string, unknown>;
      return `[${i + 1}] ${JSON.stringify(obj)}`;
    });
    const text =
      matches.length > 0
        ? lines.join("\n\n")
        : "No memories matched. If a project or date filter was set, retry once without it; otherwise treat this as not saved - do not keep re-searching. Tell the user honestly and offer to save the fact.";
    return {
      content: [{ type: "text", text }],
      structuredContent: data as unknown as { [key: string]: unknown },
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
      "List memories with previews and processing status, ordered by most recently created. Use this to BROWSE what is stored when there is no specific topic to search for - especially when the user asks 'what did I save last week?', 'show me April memories', or any time-window-only request. Parameters: optional `project` (slug), optional `start_date` and `end_date` (ISO 8601: 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM:SSZ'), optional `limit` (most recent first, default 50). See the priority rule (in CLAUDE.md, injected by the server) for the LIST vs RECALL decision (topic -> recall, no topic -> list) and the EXACT-vs-VAGUE date rule. For full content of specific IDs, use ragionex_view_memory.",
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
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .default(50)
        .describe(
          "Maximum memories to return, most recent first. Default 50. When the account holds more than this, the output says how many were omitted - narrow with project/date filters or raise the limit."
        ),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ project, start_date, end_date, limit }) => {
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
      // Distinguish "account is empty" from "filters matched nothing" - the
      // latter must not read as if the user never saved anything.
      const filtered = Boolean(project || start_date || end_date);
      return {
        content: [
          {
            type: "text",
            text: filtered
              ? "No memories match these filters. Memories may still exist outside this project/date range - retry without filters to browse everything before concluding anything is missing."
              : "No memories saved yet. Use ragionex_save_memory to save the first one.",
          },
        ],
        structuredContent: data as unknown as { [key: string]: unknown },
      };
    }
    // Rows arrive most-recent-first; cap what enters the model's context and
    // say so explicitly when older rows were cut.
    const shown = memories.slice(0, limit);
    const omitted = memories.length - shown.length;
    const lines = shown.map((m, i) => `[${i + 1}] ${JSON.stringify(m)}`);
    const text =
      omitted > 0
        ? `${lines.join("\n")}\n\nShowing the ${shown.length} most recent of ${memories.length} matching memories (${omitted} older ones omitted). Narrow with project/date filters or raise 'limit' to see more.`
        : lines.join("\n");
    return {
      content: [{ type: "text", text }],
      structuredContent: { memories: shown } as unknown as { [key: string]: unknown },
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
      "Retrieve full original content for one or more memory IDs. Use this when ragionex_list_memories or ragionex_recall_memory returned a preview and you need the complete content. Non-owned IDs are silently skipped.",
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
    const data = await api<{ id: string; status: string; message?: string }>({
      method: "GET",
      path: `/v1/memory/status/${encodeURIComponent(id)}`,
    });
    // Backend includes a guidance `message` per status (e.g. whether a failed
    // memory retries automatically or needs attention) - pass it through so
    // the calling agent can act on it.
    const text = data.message
      ? `${data.id}: ${data.status} - ${data.message}`
      : `${data.id}: ${data.status}`;
    return {
      content: [{ type: "text", text }],
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
  // Wire the offline queue to the API client (injected to avoid a circular
  // import) and attempt an initial sync of any saves queued in past sessions.
  configureOfflineQueue(async (entry) => {
    await api({
      method: "POST",
      path: "/v1/memory/write",
      body: { content: entry.content, project: entry.project },
    });
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[ragionex-memory-mcp] Connected via stdio.");
  triggerFlush();

  // Fire-and-forget key check so a misconfigured key surfaces at setup time
  // instead of mid-conversation on the first real tool call. Uses a
  // lightweight read that does not count against the plan's request quota.
  // Network failures stay silent (being offline at boot is fine); only a
  // definitive auth rejection warns.
  void (async () => {
    try {
      await api({ method: "GET", path: "/v1/memory/projects" });
    } catch (err) {
      if (
        err instanceof ApiError &&
        (err.status === 401 || err.status === 403)
      ) {
        console.error(
          "[ragionex-memory-mcp] WARNING: the API key was rejected. Every tool call will fail until RAGIONEX_MEMORY_API_KEY is corrected. Get your key at https://app.ragionex.com/keys"
        );
      }
    }
  })();
}

main().catch((err) => {
  console.error("[ragionex-memory-mcp] Fatal:", err);
  process.exit(1);
});
