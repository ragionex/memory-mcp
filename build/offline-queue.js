import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const QUEUE_DIR = join(homedir(), ".ragionex");
const QUEUE_FILE = join(QUEUE_DIR, "pending-memories.jsonl");
const TMP_FILE = `${QUEUE_FILE}.tmp`;
const MAX_QUEUE_ENTRIES = 100;
const RETRY_DELAYS_MS = [30_000, 60_000, 120_000, 300_000, 900_000, 1_800_000];
const JITTER_RATIO = 0.2;
let sender = null;
let retryTimer = null;
let retryIndex = 0;
let isFlushing = false;
function log(msg) {
    console.error(`[ragionex-memory-mcp] ${msg}`);
}
function readQueue() {
    if (!existsSync(QUEUE_FILE))
        return [];
    let raw;
    try {
        raw = readFileSync(QUEUE_FILE, "utf-8");
    }
    catch {
        return [];
    }
    const entries = [];
    for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        try {
            const obj = JSON.parse(trimmed);
            if (typeof obj.content === "string" && typeof obj.project === "string") {
                entries.push(obj);
            }
        }
        catch {
        }
    }
    return entries;
}
function writeQueue(entries) {
    const body = entries.map((e) => JSON.stringify(e)).join("\n") +
        (entries.length ? "\n" : "");
    mkdirSync(QUEUE_DIR, { recursive: true });
    writeFileSync(TMP_FILE, body, "utf-8");
    renameSync(TMP_FILE, QUEUE_FILE);
}
function queueSize() {
    return readQueue().length;
}
export function enqueuePendingMemory(entry) {
    try {
        if (queueSize() >= MAX_QUEUE_ENTRIES)
            return false;
        mkdirSync(QUEUE_DIR, { recursive: true });
        appendFileSync(QUEUE_FILE, `${JSON.stringify(entry)}\n`, "utf-8");
    }
    catch (err) {
        log(`Failed to write offline queue: ${err instanceof Error ? err.message : String(err)}`);
        return false;
    }
    scheduleRetry();
    return true;
}
export function configureOfflineQueue(fn) {
    sender = fn;
}
export function triggerFlush() {
    if (isFlushing || !sender)
        return;
    if (queueSize() === 0)
        return;
    void flushQueue();
}
async function flushQueue() {
    if (isFlushing || !sender)
        return;
    isFlushing = true;
    try {
        let entries = readQueue();
        while (entries.length > 0) {
            try {
                await sender(entries[0]);
            }
            catch {
                break;
            }
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
        }
        else {
            retryIndex = Math.min(retryIndex + 1, RETRY_DELAYS_MS.length - 1);
            scheduleRetry();
        }
    }
    finally {
        isFlushing = false;
    }
}
function scheduleRetry() {
    if (retryTimer)
        return;
    const base = RETRY_DELAYS_MS[Math.min(retryIndex, RETRY_DELAYS_MS.length - 1)];
    const jitter = base * JITTER_RATIO * (Math.random() * 2 - 1);
    retryTimer = setTimeout(() => {
        retryTimer = null;
        void flushQueue();
    }, Math.round(base + jitter));
    retryTimer.unref();
}
