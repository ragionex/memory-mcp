/**
 * Recall continuations, so the agent asks for a page number and never handles them.
 * Each connection has a private folder named like its pending-save folder, with one
 * file per search named by a digest of the Vault, normalized question and dates. A file
 * holds only its save time and the continuation for each later page, never the question,
 * record text or key. This process's own pages take precedence, so connectors running
 * at once never continue each other's searches; the file only carries a search across
 * restarts, and the last complete write wins.
 */
import * as fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import type { savedRecordSchema } from "./memory-contract.js";
import { writeNewPrivateFile } from "./durable-fs.js";
import { QUEUE_DIR, connectionFor, privateDirectory, type CredentialContext } from "./offline-queue.js";

const RECALL_DIR = join(QUEUE_DIR, "recall-pages");
const CONNECTION_FOLDER = /^[a-f0-9]{64}$/;
const RECALL_FILE = /^[a-f0-9]{64}\.(?:json|[a-f0-9-]{36}\.tmp)$/;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// A page number maps to the continuation that reads it, or to null when that page does not exist.
type Pages = Record<string, string | null>;

const storedSchema = z.object({
  saved_at: z.string().datetime(),
  pages: z.record(z.string().regex(/^(?:[2-9]|[1-9][0-9]+)$/), z.string().min(1).nullable())
    .refine(pages => Object.keys(pages).length > 0),
}).strict();

export interface RecallSearch {
  directory: string;
  digest: string;
  pages: Pages;
}

const searches = new Map<string, { savedAt: number; pages: Pages }>();

export interface RecallRemainder {
  matches: z.infer<typeof savedRecordSchema>[];
  nextCursor: string | null;
}

const REMAINDER_BUDGET_BYTES = 4_000_000;
const remainders = new Map<string, { page: number; bytes: number; data: RecallRemainder }>();

export function getRecallRemainder(search: RecallSearch, page: number): RecallRemainder | undefined {
  const held = remainders.get(join(search.directory, `${search.digest}.json`));
  return held?.page === page ? held.data : undefined;
}

export function findRecallSearch(
  context: CredentialContext & { vaultId?: string },
  query: string,
  startDate: string | null,
  endDate: string | null,
): RecallSearch {
  const question = query.trim().replace(/\s+/g, " ").toLowerCase();
  const directory = join(RECALL_DIR, connectionFor(context).id);
  const digest = createHash("sha256")
    .update(JSON.stringify([context.vaultId ?? null, question, startDate, endDate]))
    .digest("hex");
  const file = join(directory, `${digest}.json`);
  const now = Date.now();
  const held = searches.get(file);
  if (held && now - held.savedAt <= RETENTION_MS) return { directory, digest, pages: held.pages };
  remainders.delete(file);
  try {
    const stored = storedSchema.parse(JSON.parse(fs.readFileSync(file, "utf-8")));
    const savedAt = Date.parse(stored.saved_at);
    if (now - savedAt <= RETENTION_MS) {
      searches.set(file, { savedAt, pages: stored.pages });
      return { directory, digest, pages: stored.pages };
    }
  } catch {
    // A missing, unreadable or malformed file leaves the search unstored.
  }
  return { directory, digest, pages: {} };
}

/** Records the page after `page`; entries above it belonged to the replaced page and are dropped. */
export function storeRecallPage(search: RecallSearch, page: number, next: string | null, remainder?: RecallRemainder): void {
  const now = Date.now();
  const pages: Pages = {};
  for (const [pageKey, value] of Object.entries(search.pages)) {
    if (Number(pageKey) <= page) pages[pageKey] = value;
  }
  pages[String(page + 1)] = next;
  const file = join(search.directory, `${search.digest}.json`);
  searches.set(file, { savedAt: now, pages });
  remainders.delete(file);
  if (remainder && remainder.matches.length > 0) {
    const bytes = Buffer.byteLength(JSON.stringify(remainder.matches), "utf8");
    if (bytes <= REMAINDER_BUDGET_BYTES) {
      remainders.set(file, { page: page + 1, bytes, data: remainder });
      let retainedBytes = 0;
      for (const held of remainders.values()) retainedBytes += held.bytes;
      for (const [key, held] of remainders) {
        if (retainedBytes <= REMAINDER_BUDGET_BYTES) break;
        remainders.delete(key);
        retainedBytes -= held.bytes;
      }
    }
  }
  const temporary = join(search.directory, `${search.digest}.${randomUUID()}.tmp`);
  try {
    privateDirectory(QUEUE_DIR);
    privateDirectory(RECALL_DIR);
    privateDirectory(search.directory);
    writeNewPrivateFile(temporary, JSON.stringify({ saved_at: new Date(now).toISOString(), pages }));
    fs.renameSync(temporary, file);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // A leftover temporary file is removed once it expires.
    }
    const reason = (error as NodeJS.ErrnoException)?.code ?? (error instanceof Error ? error.message : String(error));
    console.error(`[ragionex-memory-mcp] Recall pages could not be saved to disk (${reason}); this connector keeps them in memory.`);
  }
  for (const [key, held] of searches) {
    if (now - held.savedAt > RETENTION_MS) {
      searches.delete(key);
      remainders.delete(key);
    }
  }
  let connections: fs.Dirent[];
  try {
    connections = fs.readdirSync(RECALL_DIR, { withFileTypes: true });
  } catch {
    return;
  }
  // Every connection folder is swept, so an abandoned key's files expire too.
  for (const connection of connections) {
    if (!connection.isDirectory() || !CONNECTION_FOLDER.test(connection.name)) continue;
    const folder = join(RECALL_DIR, connection.name);
    try {
      for (const name of fs.readdirSync(folder)) {
        if (!RECALL_FILE.test(name)) continue;
        const stale = join(folder, name);
        try {
          if (now - fs.lstatSync(stale).mtimeMs > RETENTION_MS) fs.rmSync(stale, { force: true });
        } catch {
          // Another connector replaced or removed it.
        }
      }
      // Removes only an empty folder; a folder still holding any file stays.
      fs.rmdirSync(folder);
    } catch {
      // A folder still in use or already removed stays as it is.
    }
  }
}
