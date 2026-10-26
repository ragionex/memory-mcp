import * as fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { isMissing, syncDirectory, writeNewPrivateFile } from "./durable-fs.js";
import { ApiError, normalizeApiBase, vaultId, writePayloadSchema, } from "./memory-contract.js";
export const QUEUE_DIR = join(homedir(), ".ragionex");
export const SPOOL_DIR = join(QUEUE_DIR, "pending-saves");
const LEGACY_FILES = [
    join(QUEUE_DIR, "pending-memories.jsonl"),
    join(QUEUE_DIR, "pending-memories.jsonl.tmp"),
];
const MAX_QUEUE_ENTRIES = 100;
const CONNECTION_DIRECTORY = /^[a-f0-9]{64}$/;
const PENDING_FILE = /^[a-f0-9-]{36}\.pending\.json$/;
const BLOCKED_FILE = /^[a-f0-9-]{36}\.blocked-[a-z_]+\.json$/;
const RETRY_DELAYS_MS = [30_000, 60_000, 120_000, 300_000, 900_000, 1_800_000];
const JITTER_RATIO = 0.2;
const REASONS = {
    authentication_required: "The key needs attention.",
    permission_denied: "The key lacks create permission.",
    plan_limit: "The account plan limit was reached.",
    rate_limit: "The service requested a retry delay.",
    idempotency_mismatch: "The request ID conflicts with a different payload.",
    record_deleted: "The accepted record was deleted; it will not be recreated.",
    invalid_request: "The service rejected this payload.",
    request_rejected: "The request was rejected and needs review.",
    service_unreachable: "The save outcome is not confirmed.",
};
const envelopeSchema = z.object({
    operation_id: z.string().uuid(),
    connection_id: z.string().regex(/^[a-f0-9]{64}$/),
    vault_id: vaultId.nullable(),
    created_at: z.string().datetime(),
    payload: writePayloadSchema,
    checksum: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
let readCredential;
let sendMemory;
const retryStates = new Map();
let isFlushing = false;
let flushRequested = false;
let retryTimer = null;
const inFlight = new Set();
export function connectionFor(context) {
    const id = hash(JSON.stringify([normalizeApiBase(context.apiBase), context.key]));
    return { id, directory: join(SPOOL_DIR, id) };
}
function stateFor(id) {
    let state = retryStates.get(id);
    if (!state) {
        state = {
            retryIndex: 0, localRetryAt: 0, serverRetryAt: 0,
            lastFailure: null, storageFailure: null, vaultRetryAt: new Map(),
        };
        retryStates.set(id, state);
    }
    return state;
}
function log(message) {
    console.error(`[ragionex-memory-mcp] ${message}`);
}
function hash(value) {
    return createHash("sha256").update(value).digest("hex");
}
function checksum(entry) {
    return hash(JSON.stringify([
        entry.operation_id,
        entry.connection_id,
        entry.vault_id,
        entry.created_at,
        entry.payload,
    ]));
}
export function privateDirectory(directory) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("The pending-save directory must be a real directory.");
    }
}
function ensureDirectories(current) {
    privateDirectory(QUEUE_DIR);
    privateDirectory(SPOOL_DIR);
    privateDirectory(current.directory);
    syncDirectory(homedir());
    syncDirectory(QUEUE_DIR);
    syncDirectory(SPOOL_DIR);
}
function cause(error) {
    return error?.code ?? (error instanceof Error ? error.message : String(error));
}
function jittered(base) {
    return Math.round(base * (1 + JITTER_RATIO * (Math.random() * 2 - 1)));
}
function nextAttemptAt(state, target) {
    return Math.max(state.localRetryAt, state.serverRetryAt, target !== undefined ? state.vaultRetryAt.get(target) ?? 0 : 0);
}
function reasonFor(error) {
    if (!(error instanceof ApiError))
        return "service_unreachable";
    if (error.code === "idempotency_mismatch")
        return "idempotency_mismatch";
    if (error.code === "record_deleted")
        return "record_deleted";
    if (error.status === 401)
        return "authentication_required";
    if (error.status === 403)
        return "permission_denied";
    if (error.status === 402)
        return "plan_limit";
    if (error.status === 429)
        return "rate_limit";
    if (error.status === 400 || error.status === 422)
        return "invalid_request";
    if (error.status !== undefined && error.status < 500)
        return "request_rejected";
    return "service_unreachable";
}
function pendingPath(entry) {
    return join(entry.directory, `${entry.envelope.operation_id}.pending.json`);
}
function snapshot(connection, pendingOnly = false) {
    const result = { pending: [], blocked: [], recovery: [] };
    let files;
    try {
        files = fs.readdirSync(connection.directory, { withFileTypes: true });
    }
    catch (error) {
        if (isMissing(error))
            return result;
        throw error;
    }
    for (const item of files) {
        if (pendingOnly && !PENDING_FILE.test(item.name))
            continue;
        const file = join(connection.directory, item.name);
        const match = /^([a-f0-9-]{36})\.(pending|blocked-([a-z_]+))\.json$/.exec(item.name);
        if (!item.isFile() || !match || (match[3] && !Object.hasOwn(REASONS, match[3]))) {
            result.recovery.push({ path: file, reason: "Temporary or unrecognized local data; explicit recovery required." });
            continue;
        }
        try {
            const serialized = fs.readFileSync(file, "utf-8");
            const parsed = envelopeSchema.safeParse(JSON.parse(serialized));
            if (!parsed.success ||
                parsed.data.operation_id !== match[1] ||
                parsed.data.connection_id !== connection.id ||
                parsed.data.checksum !== checksum(parsed.data)) {
                result.recovery.push({ path: file, reason: "Malformed or unattributed save; explicit recovery required." });
                continue;
            }
            const entry = { envelope: parsed.data, directory: connection.directory, serialized };
            if (match[2] === "pending") {
                result.pending.push(entry);
            }
            else {
                result.blocked.push({
                    operation_id: parsed.data.operation_id,
                    vault_id: parsed.data.vault_id,
                    created_at: parsed.data.created_at,
                    reason: match[3],
                    path: file,
                });
            }
        }
        catch (error) {
            if (!isMissing(error)) {
                result.recovery.push({ path: file, reason: "Unreadable or malformed save; explicit recovery required." });
            }
        }
    }
    result.pending.sort((a, b) => a.envelope.created_at.localeCompare(b.envelope.created_at) ||
        a.envelope.operation_id.localeCompare(b.envelope.operation_id));
    return result;
}
export function configureOfflineQueue(credentialReader, sender) {
    readCredential = credentialReader;
    sendMemory = sender;
}
export function stagePendingMemory(context, target, payload) {
    const connection = connectionFor(context);
    const state = stateFor(connection.id);
    ensureDirectories(connection);
    const count = fs.readdirSync(connection.directory, { withFileTypes: true })
        .filter(item => item.isFile() && /^[a-f0-9-]{36}\.(pending\.json|tmp)$/.test(item.name))
        .length;
    if (count >= MAX_QUEUE_ENTRIES) {
        throw new Error(`Pending-save storage is full: ${MAX_QUEUE_ENTRIES} saves are still waiting to sync, so this save was not stored. Use ragionex_memory_connection to check them and start a sync, then save again once they have synced.`);
    }
    const operationId = randomUUID();
    const data = {
        operation_id: operationId,
        connection_id: connection.id,
        vault_id: target,
        created_at: new Date().toISOString(),
        payload,
    };
    const envelope = { ...data, checksum: checksum(data) };
    const serialized = `${JSON.stringify(envelope)}\n`;
    const entry = { envelope, directory: connection.directory, serialized };
    try {
        const temporary = join(connection.directory, `${operationId}.tmp`);
        writeNewPrivateFile(temporary, serialized);
        fs.renameSync(temporary, pendingPath(entry));
        syncDirectory(connection.directory);
        inFlight.add(operationId);
        state.storageFailure = null;
        return { ...entry, deferred: Date.now() < state.serverRetryAt };
    }
    catch (error) {
        throw new Error(`Save preparation could not be confirmed for operation ${operationId} (${cause(error)}). Preserved files are at ${connection.directory}. Check ragionex_memory_connection before resubmitting.`);
    }
}
export function acknowledgePendingMemory(entry) {
    let removed = false;
    try {
        const names = [
            `${entry.envelope.operation_id}.pending.json`,
            ...Object.keys(REASONS).map(reason => `${entry.envelope.operation_id}.blocked-${reason}.json`),
        ];
        for (const name of names) {
            const file = join(entry.directory, name);
            try {
                if (fs.readFileSync(file, "utf-8") !== entry.serialized) {
                    throw new Error("The saved entry changed while delivery was in progress.");
                }
                fs.unlinkSync(file);
                removed = true;
            }
            catch (error) {
                if (!isMissing(error))
                    throw error;
            }
        }
        if (removed)
            syncDirectory(entry.directory);
        stateFor(entry.envelope.connection_id).storageFailure = null;
        return true;
    }
    catch (error) {
        const state = stateFor(entry.envelope.connection_id);
        state.storageFailure = `A save was accepted but its local acknowledgement could not be confirmed (${cause(error)}). Check ragionex_memory_connection; do not resubmit it with a new request ID. Restarting the agent retries preserved saves safely with the same request IDs.`;
        log(state.storageFailure);
        postpone(state, error);
        return false;
    }
}
export function discardPendingMemory(entry) {
    try {
        const file = pendingPath(entry);
        if (fs.readFileSync(file, "utf-8") !== entry.serialized) {
            throw new Error("The pending entry changed.");
        }
        fs.unlinkSync(file);
        syncDirectory(entry.directory);
        return true;
    }
    catch (error) {
        if (isMissing(error))
            return true;
        log(`Rejected save ${entry.envelope.operation_id} could not be removed (${cause(error)}); replay may send it again.`);
        return false;
    }
}
function blockPendingMemory(entry, error) {
    const reason = reasonFor(error);
    try {
        const source = pendingPath(entry);
        try {
            if (fs.readFileSync(source, "utf-8") !== entry.serialized) {
                throw new Error("The pending entry changed.");
            }
            fs.renameSync(source, join(entry.directory, `${entry.envelope.operation_id}.blocked-${reason}.json`));
        }
        catch (renameError) {
            if (isMissing(renameError))
                return true;
            throw renameError;
        }
        syncDirectory(entry.directory);
        stateFor(entry.envelope.connection_id).storageFailure = null;
        log(`Pending save ${entry.envelope.operation_id} needs recovery: ${REASONS[reason]}`);
        return true;
    }
    catch (failure) {
        const state = stateFor(entry.envelope.connection_id);
        state.storageFailure = `A rejected save could not be marked for recovery (${cause(failure)}). Stop connector instances and inspect the preserved pending files before resubmitting. Restarting the agent retries preserved saves safely with the same request IDs.`;
        log(state.storageFailure);
        postpone(state, failure);
        return false;
    }
}
function postpone(state, error, target) {
    state.lastFailure = reasonFor(error);
    const now = Date.now();
    if (target !== undefined && error instanceof ApiError &&
        ((error.status === 403 && error.code === "no_access") || error.code === "vault_not_found")) {
        state.vaultRetryAt.set(target, Math.max(state.vaultRetryAt.get(target) ?? 0, now + 1_800_000));
        if (error.retryAfterMs !== undefined)
            state.serverRetryAt = Math.max(state.serverRetryAt, now + error.retryAfterMs);
        return;
    }
    const connectionPause = ["authentication_required", "permission_denied", "plan_limit"].includes(state.lastFailure)
        ? 1_800_000
        : 0;
    state.localRetryAt = Math.max(state.localRetryAt, now + Math.max(jittered(RETRY_DELAYS_MS[state.retryIndex]), connectionPause));
    const serverDelay = error instanceof ApiError ? error.retryAfterMs : undefined;
    if (serverDelay === undefined) {
        state.retryIndex = Math.min(state.retryIndex + 1, RETRY_DELAYS_MS.length - 1);
    }
    else {
        state.serverRetryAt = Math.max(state.serverRetryAt, now + serverDelay);
    }
}
export function deferPendingMemory(entry, error) {
    postpone(stateFor(entry.envelope.connection_id), error, entry.envelope.vault_id);
}
export function releasePendingMemory(entry, context) {
    inFlight.delete(entry.envelope.operation_id);
    triggerFlush(context);
}
export function triggerFlush(context) {
    if (!readCredential || !sendMemory)
        return;
    if (isFlushing) {
        flushRequested = true;
        return;
    }
    void flushQueue(context);
}
export function syncPendingNow(context) {
    const alreadyFlushing = isFlushing;
    const state = stateFor(connectionFor(context).id);
    state.retryIndex = 0;
    state.localRetryAt = 0;
    state.vaultRetryAt.clear();
    triggerFlush(context);
    return !alreadyFlushing && isFlushing;
}
async function flushQueue(supplied) {
    if (!readCredential || !sendMemory || isFlushing)
        return;
    isFlushing = true;
    let current;
    let state;
    try {
        let context;
        try {
            context = supplied ?? await readCredential();
        }
        catch (error) {
            log(`queue_configuration_unavailable: ${error.code ?? "configuration_error"}`);
            return;
        }
        current = connectionFor(context);
        state = stateFor(current.id);
        if (Date.now() < nextAttemptAt(state))
            return;
        state.storageFailure = null;
        const entries = snapshot(current, true).pending.filter(entry => !inFlight.has(entry.envelope.operation_id));
        if (entries.length === 0)
            return;
        let previousFailed = false;
        for (const entry of entries) {
            if (Date.now() < (state.vaultRetryAt.get(entry.envelope.vault_id) ?? 0))
                continue;
            if (!fs.existsSync(pendingPath(entry)))
                continue;
            inFlight.add(entry.envelope.operation_id);
            try {
                await sendMemory(context, entry.envelope.payload, entry.envelope.operation_id, entry.envelope.vault_id);
            }
            catch (error) {
                if (error instanceof ApiError && error.status === 401) {
                    state.lastFailure = reasonFor(error);
                    for (const pending of snapshot(current, true).pending) {
                        if (pending.envelope.operation_id !== entry.envelope.operation_id &&
                            inFlight.has(pending.envelope.operation_id))
                            continue;
                        if (!blockPendingMemory(pending, error))
                            break;
                    }
                    break;
                }
                if (error instanceof ApiError &&
                    ((error.status === 403 && error.code === "no_access") || error.code === "vault_not_found")) {
                    postpone(state, error, entry.envelope.vault_id);
                    previousFailed = false;
                    if (error.retryAfterMs !== undefined)
                        break;
                    continue;
                }
                if (error instanceof ApiError &&
                    error.status !== undefined &&
                    error.status < 500 &&
                    ![402, 403, 429].includes(error.status)) {
                    if (!blockPendingMemory(entry, error))
                        break;
                    previousFailed = false;
                    continue;
                }
                postpone(state, error);
                const payloadSpecific = error instanceof ApiError && error.status !== undefined &&
                    error.status >= 500 && error.retryAfterMs === undefined;
                if (!payloadSpecific || previousFailed)
                    break;
                previousFailed = true;
                continue;
            }
            finally {
                inFlight.delete(entry.envelope.operation_id);
            }
            previousFailed = false;
            if (!acknowledgePendingMemory(entry))
                break;
            log(`Pending save ${entry.envelope.operation_id} was accepted.`);
        }
    }
    catch (error) {
        if (state) {
            state.storageFailure = `Pending saves could not be inspected safely (${cause(error)}). Check ragionex_memory_connection. Restarting the agent retries preserved saves safely with the same request IDs.`;
            log(state.storageFailure);
            postpone(state, error);
        }
    }
    finally {
        isFlushing = false;
        if (flushRequested) {
            flushRequested = false;
            triggerFlush();
        }
        else {
            scheduleRetry(current);
        }
    }
}
function scheduleRetry(current) {
    if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
    }
    if (!current || !readCredential || !sendMemory)
        return;
    const state = stateFor(current.id);
    let delay;
    try {
        const pending = snapshot(current, true).pending;
        if (pending.length === 0) {
            state.retryIndex = 0;
            state.localRetryAt = 0;
            if (state.serverRetryAt <= Date.now())
                state.serverRetryAt = 0;
            state.lastFailure = null;
            state.vaultRetryAt.clear();
            return;
        }
        const entries = pending.filter(entry => !inFlight.has(entry.envelope.operation_id));
        if (entries.length === 0)
            return;
        const at = Math.min(...entries.map(entry => nextAttemptAt(state, entry.envelope.vault_id)));
        delay = Math.min(2_147_483_647, Math.max(1, at ? at - Date.now() : jittered(RETRY_DELAYS_MS[state.retryIndex])));
    }
    catch (error) {
        state.storageFailure = `Pending saves could not be inspected safely (${cause(error)}). Check ragionex_memory_connection. Restarting the agent retries preserved saves safely with the same request IDs.`;
        log(state.storageFailure);
        if (Date.now() >= nextAttemptAt(state))
            postpone(state, error);
        delay = Math.min(2_147_483_647, Math.max(1, nextAttemptAt(state) - Date.now()));
    }
    retryTimer = setTimeout(() => {
        retryTimer = null;
        triggerFlush();
    }, delay);
    retryTimer.unref();
}
export function getQueueStatus(context) {
    const connection = connectionFor(context);
    const state = stateFor(connection.id);
    let current = { pending: [], blocked: [], recovery: [] };
    try {
        current = snapshot(connection);
    }
    catch (error) {
        current.recovery.push({ path: connection?.directory ?? SPOOL_DIR, reason: `Local storage is unreadable (${cause(error)}).` });
    }
    for (const file of LEGACY_FILES) {
        try {
            fs.lstatSync(file);
            current.recovery.push({ path: file, reason: "Unattributed existing file. Never automatically sent; explicit recovery required." });
        }
        catch (error) {
            if (!isMissing(error))
                current.recovery.push({ path: file, reason: "Existing file could not be inspected." });
        }
    }
    let otherConnections = 0;
    try {
        otherConnections = connectionDirectories()
            .filter(name => name !== connection?.id)
            .filter(name => {
            const saves = storedSaves(join(SPOOL_DIR, name));
            return saves.pending + saves.blocked > 0;
        })
            .length;
    }
    catch (error) {
        if (!isMissing(error))
            current.recovery.push({ path: SPOOL_DIR, reason: "Other local connections could not be inspected." });
    }
    const nextAttempt = current.pending.length
        ? Math.min(...current.pending.map(entry => nextAttemptAt(state, entry.envelope.vault_id)))
        : nextAttemptAt(state);
    return {
        pending: current.pending.map(entry => ({
            operation_id: entry.envelope.operation_id,
            vault_id: entry.envelope.vault_id,
            ...(entry.envelope.vault_id === null ? { vault_source: "account_default" } : {}),
            created_at: entry.envelope.created_at,
            state: "pending",
            path: pendingPath(entry),
        })),
        blocked: current.blocked.map(entry => ({
            ...entry,
            ...(entry.vault_id === null ? { vault_source: "account_default" } : {}),
            state: "blocked",
            message: REASONS[entry.reason],
        })),
        recovery_required: current.recovery,
        other_connection_directories: otherConnections,
        recovery_root: SPOOL_DIR,
        last_failure: state.lastFailure,
        next_retry_at: nextAttempt ? new Date(nextAttempt).toISOString() : null,
        storage_error: state.storageFailure,
    };
}
function connectionDirectories() {
    try {
        return fs.readdirSync(SPOOL_DIR, { withFileTypes: true })
            .filter(entry => entry.isDirectory() && CONNECTION_DIRECTORY.test(entry.name))
            .map(entry => entry.name);
    }
    catch (error) {
        if (isMissing(error))
            return [];
        throw error;
    }
}
function storedSaves(directory) {
    const saves = { pending: 0, blocked: 0 };
    for (const name of fs.readdirSync(directory)) {
        if (PENDING_FILE.test(name))
            saves.pending++;
        else if (BLOCKED_FILE.test(name))
            saves.blocked++;
    }
    return saves;
}
export function countStoredSaves() {
    const total = { pending: 0, blocked: 0 };
    for (const name of connectionDirectories()) {
        const saves = storedSaves(join(SPOOL_DIR, name));
        total.pending += saves.pending;
        total.blocked += saves.blocked;
    }
    return total;
}
