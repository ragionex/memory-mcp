/**
 * Offline save queue for ragionex_save_memory.
 *
 * When the memory service is unreachable at save time (network error or 5xx),
 * the payload is appended to a local JSONL file instead of being lost. Queued
 * entries are re-sent automatically:
 *  - on server boot,
 *  - after any successful API call (the service is clearly reachable again),
 *  - on an exponential-backoff timer while the queue is non-empty.
 *
 * The retry timer is unref()'d so it never keeps the process alive after the
 * MCP client closes stdio, and it only exists while there is something to send.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const QUEUE_DIR = join(homedir(), ".ragionex");
const QUEUE_FILE = join(QUEUE_DIR, "pending-memories.jsonl");
const TMP_FILE = `${QUEUE_FILE}.tmp`;
const MAX_QUEUE_ENTRIES = 100;

// Retry delays: fast at first (covers short blips), settling at a 30-minute
// ceiling so a long outage costs at most ~2 requests/hour per client.
const RETRY_DELAYS_MS = [30_000, 60_000, 120_000, 300_000, 900_000, 1_800_000];
// +/-20% jitter so many clients recovering from the same outage do not all
// retry at the same instant.
const JITTER_RATIO = 0.2;

export interface PendingMemory {
  content: string;
  project: string;
  ts: string;
}

type Sender = (entry: PendingMemory) => Promise<void>;

let sender: Sender | null = null;
let retryTimer: NodeJS.Timeout | null = null;
let retryIndex = 0;
let isFlushing = false;

function log(msg: string): void {
  console.error(`[ragionex-memory-mcp] ${msg}`);
}

function readQueue(): PendingMemory[] {
  if (!existsSync(QUEUE_FILE)) return [];
  let raw: string;
  try {
    raw = readFileSync(QUEUE_FILE, "utf-8");
  } catch {
    return [];
  }
  const entries: PendingMemory[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as PendingMemory;
      if (typeof obj.content === "string" && typeof obj.project === "string") {
        entries.push(obj);
      }
    } catch {
      // Skip malformed lines rather than failing the whole queue.
    }
  }
  return entries;
}

/** Atomic rewrite (temp file + rename) so a crash mid-write cannot corrupt
 * the queue file. */
function writeQueue(entries: PendingMemory[]): void {
  const body =
    entries.map((e) => JSON.stringify(e)).join("\n") +
    (entries.length ? "\n" : "");
  mkdirSync(QUEUE_DIR, { recursive: true });
  writeFileSync(TMP_FILE, body, "utf-8");
  renameSync(TMP_FILE, QUEUE_FILE);
}

function queueSize(): number {
  return readQueue().length;
}

/** Append a failed save to the queue. Returns false when the queue is full or
 * the file cannot be written - the caller must then surface the original save
 * error instead of pretending the memory is safe. */
export function enqueuePendingMemory(entry: PendingMemory): boolean {
  try {
    if (queueSize() >= MAX_QUEUE_ENTRIES) return false;
    mkdirSync(QUEUE_DIR, { recursive: true });
    appendFileSync(QUEUE_FILE, `${JSON.stringify(entry)}\n`, "utf-8");
  } catch (err) {
    log(
      `Failed to write offline queue: ${err instanceof Error ? err.message : String(err)}`
    );
    return false;
  }
  scheduleRetry();
  return true;
}

/** Register the function that delivers one queued entry (wired to the API
 * client in index.ts; kept injected here to avoid a circular import). */
export function configureOfflineQueue(fn: Sender): void {
  sender = fn;
}

/** Fire-and-forget flush trigger. Cheap no-op when there is nothing to send
 * or a flush is already running. */
export function triggerFlush(): void {
  if (isFlushing || !sender) return;
  if (queueSize() === 0) return;
  void flushQueue();
}

async function flushQueue(): Promise<void> {
  if (isFlushing || !sender) return;
  isFlushing = true;
  try {
    let entries = readQueue();
    while (entries.length > 0) {
      try {
        await sender(entries[0]);
      } catch {
        break; // Still unreachable (or rejected) - keep the rest queued.
      }
      // Persist progress after every delivered entry so a crash mid-flush
      // re-sends at most one memory.
      entries = entries.slice(1);
      writeQueue(entries);
      log(`Offline queue: 1 pending memory synced, ${entries.length} remaining.`);
    }
    if (entries.length === 0) {
      retryIndex = 0;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    } else {
      retryIndex = Math.min(retryIndex + 1, RETRY_DELAYS_MS.length - 1);
      scheduleRetry();
    }
  } finally {
    isFlushing = false;
  }
}

function scheduleRetry(): void {
  if (retryTimer) return;
  const base = RETRY_DELAYS_MS[Math.min(retryIndex, RETRY_DELAYS_MS.length - 1)];
  const jitter = base * JITTER_RATIO * (Math.random() * 2 - 1);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void flushQueue();
  }, Math.round(base + jitter));
  // Never keep the process alive just for the retry timer.
  retryTimer.unref();
}
