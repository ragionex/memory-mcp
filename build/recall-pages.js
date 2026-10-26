import * as fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { writeNewPrivateFile } from "./durable-fs.js";
import { QUEUE_DIR, connectionFor, privateDirectory } from "./offline-queue.js";
const RECALL_DIR = join(QUEUE_DIR, "recall-pages");
const CONNECTION_FOLDER = /^[a-f0-9]{64}$/;
const RECALL_FILE = /^[a-f0-9]{64}\.(?:json|[a-f0-9-]{36}\.tmp)$/;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const storedSchema = z.object({
    saved_at: z.string().datetime(),
    pages: z.record(z.string().regex(/^(?:[2-9]|[1-9][0-9]+)$/), z.string().min(1).nullable())
        .refine(pages => Object.keys(pages).length > 0),
}).strict();
const searches = new Map();
const REMAINDER_BUDGET_BYTES = 4_000_000;
const remainders = new Map();
export function getRecallRemainder(search, page) {
    const held = remainders.get(join(search.directory, `${search.digest}.json`));
    return held?.page === page ? held.data : undefined;
}
export function findRecallSearch(context, query, startDate, endDate) {
    const question = query.trim().replace(/\s+/g, " ").toLowerCase();
    const directory = join(RECALL_DIR, connectionFor(context).id);
    const digest = createHash("sha256")
        .update(JSON.stringify([context.vaultId ?? null, question, startDate, endDate]))
        .digest("hex");
    const file = join(directory, `${digest}.json`);
    const now = Date.now();
    const held = searches.get(file);
    if (held && now - held.savedAt <= RETENTION_MS)
        return { directory, digest, pages: held.pages };
    remainders.delete(file);
    try {
        const stored = storedSchema.parse(JSON.parse(fs.readFileSync(file, "utf-8")));
        const savedAt = Date.parse(stored.saved_at);
        if (now - savedAt <= RETENTION_MS) {
            searches.set(file, { savedAt, pages: stored.pages });
            return { directory, digest, pages: stored.pages };
        }
    }
    catch {
    }
    return { directory, digest, pages: {} };
}
export function storeRecallPage(search, page, next, remainder) {
    const now = Date.now();
    const pages = {};
    for (const [pageKey, value] of Object.entries(search.pages)) {
        if (Number(pageKey) <= page)
            pages[pageKey] = value;
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
            for (const held of remainders.values())
                retainedBytes += held.bytes;
            for (const [key, held] of remainders) {
                if (retainedBytes <= REMAINDER_BUDGET_BYTES)
                    break;
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
    }
    catch (error) {
        try {
            fs.rmSync(temporary, { force: true });
        }
        catch {
        }
        const reason = error?.code ?? (error instanceof Error ? error.message : String(error));
        console.error(`[ragionex-memory-mcp] Recall pages could not be saved to disk (${reason}); this connector keeps them in memory.`);
    }
    for (const [key, held] of searches) {
        if (now - held.savedAt > RETENTION_MS) {
            searches.delete(key);
            remainders.delete(key);
        }
    }
    let connections;
    try {
        connections = fs.readdirSync(RECALL_DIR, { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const connection of connections) {
        if (!connection.isDirectory() || !CONNECTION_FOLDER.test(connection.name))
            continue;
        const folder = join(RECALL_DIR, connection.name);
        try {
            for (const name of fs.readdirSync(folder)) {
                if (!RECALL_FILE.test(name))
                    continue;
                const stale = join(folder, name);
                try {
                    if (now - fs.lstatSync(stale).mtimeMs > RETENTION_MS)
                        fs.rmSync(stale, { force: true });
                }
                catch {
                }
            }
            fs.rmdirSync(folder);
        }
        catch {
        }
    }
}
