import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { tempDir } from "./helpers.js";

const run = promisify(execFile);
const bootstrap = `
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import * as queue from ${JSON.stringify(new URL("../build/offline-queue.js", import.meta.url).href)};
import { ApiError } from ${JSON.stringify(new URL("../build/memory-contract.js", import.meta.url).href)};
const context = { apiBase: "http://127.0.0.1:9", key: "rgx_memory_" + "a".repeat(48) };
const vault = "b".repeat(32);
let now = Date.now();
Date.now = () => now;
const timers = new Set();
globalThis.setTimeout = (callback, delay) => {
  const timer = { callback, delay, unref() { return this; } };
  timers.add(timer);
  return timer;
};
globalThis.clearTimeout = timer => timers.delete(timer);
const settle = () => new Promise(resolve => setImmediate(resolve));
`;

for (const [name, scenario] of [
  ["empty or keyless queues do not poll and scheduling reuses the selected connection", `
    let reads = 0;
    let sends = 0;
    queue.configureOfflineQueue(async () => {
      reads++;
      throw new Error("No fixture credential.");
    }, async () => { sends++; });
    queue.triggerFlush();
    await settle();
    assert.equal(reads, 1);
    assert.equal(timers.size, 0);
    queue.configureOfflineQueue(async () => { reads++; return context; }, async () => { sends++; });
    queue.triggerFlush(context);
    await settle();
    assert.equal(reads, 1);
    assert.equal(timers.size, 0);
    const entry = queue.stagePendingMemory(context, null, { content: "Retry this entry." });
    queue.deferPendingMemory(entry, new ApiError("Unavailable.", 500));
    queue.releasePendingMemory(entry, context);
    await settle();
    assert.equal(reads, 1);
    assert.equal(timers.size, 1);
    const timer = [...timers][0];
    now += timer.delay + 1;
    timers.delete(timer);
    timer.callback();
    await settle();
    assert.equal(reads, 2);
    assert.equal(sends, 1);
    assert.equal(timers.size, 0);
  `],
  ["fresh staging obeys only the existing server deadline without extending it", `
    queue.configureOfflineQueue(async () => context, async () => {});
    const first = queue.stagePendingMemory(context, null, { content: "First delayed entry." });
    queue.deferPendingMemory(first, new ApiError("Rate limited.", 429, "rate_limited", 3_600_000));
    queue.releasePendingMemory(first, context);
    await settle();
    const deadline = queue.getQueueStatus(context).next_retry_at;
    const held = queue.stagePendingMemory(context, vault, { content: "A new held entry." });
    assert.equal(held.deferred, true);
    queue.releasePendingMemory(held, context);
    await settle();
    queue.syncPendingNow(context);
    await settle();
    assert.equal(queue.getQueueStatus(context).next_retry_at, deadline);
    assert.equal(timers.size, 1);
    now += 3_600_001;
    const fresh = queue.stagePendingMemory(context, null, { content: "After the deadline." });
    assert.equal(fresh.deferred, false);
    queue.releasePendingMemory(fresh, context);
    await settle();
    assert.equal(timers.size, 0);
    const local = queue.stagePendingMemory(context, null, { content: "Local backoff only." });
    queue.deferPendingMemory(local, new ApiError("Plan limit.", 402));
    const immediate = queue.stagePendingMemory(context, null, { content: "A fresh attempt is allowed." });
    assert.equal(immediate.deferred, false);
  `],
  ["storage retry keeps the operation and scheduler never reads blocked content", `
    const sent = [];
    queue.configureOfflineQueue(async () => context, async (_context, payload, operationId, target) => {
      sent.push({ payload, operationId, target });
    });
    const entry = queue.stagePendingMemory(context, null, { content: "Accepted before local failure." });
    const pending = path.join(entry.directory, entry.envelope.operation_id + ".pending.json");
    const blocked = path.join(entry.directory, "11111111-1111-4111-8111-111111111111.blocked-invalid_request.json");
    fs.writeFileSync(blocked, "{}");
    const read = fs.readFileSync;
    const unlink = fs.unlinkSync;
    let denied = true;
    let blockedReads = 0;
    fs.readFileSync = (file, ...args) => {
      if (file === blocked) {
        blockedReads++;
        throw new Error("Blocked content must not be read by scheduling.");
      }
      return read(file, ...args);
    };
    fs.unlinkSync = file => {
      if (file === pending && denied) throw Object.assign(new Error("Denied."), { code: "EACCES" });
      return unlink(file);
    };
    syncBuiltinESMExports();
    queue.releasePendingMemory(entry, context);
    await settle();
    assert.equal(sent.length, 1);
    assert.equal(fs.existsSync(pending), true);
    assert.equal(timers.size, 1);
    assert.equal(blockedReads, 0);
    const timer = [...timers][0];
    assert.ok(timer.delay >= 24_000 && timer.delay <= 36_000);
    denied = false;
    now += timer.delay + 1;
    timers.delete(timer);
    timer.callback();
    await settle();
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[0], sent[1]);
    assert.equal(sent[0].operationId, entry.envelope.operation_id);
    assert.equal(fs.existsSync(pending), false);
    assert.equal(blockedReads, 0);
    assert.equal(timers.size, 0);
    fs.readFileSync = read;
    fs.unlinkSync = unlink;
    syncBuiltinESMExports();
    assert.equal(queue.getQueueStatus(context).storage_error, null);
  `],
  ["a concurrent wake rechecks credentials after the active flush finishes", `
    const other = { ...context, key: "rgx_memory_" + "b".repeat(48) };
    let selected = context;
    let reads = 0;
    let finish;
    const sent = [];
    queue.configureOfflineQueue(async () => { reads++; return selected; }, async (credential, _payload, operationId, target) => {
      sent.push([credential.key, operationId, target]);
      if (credential.key === context.key) await new Promise(resolve => { finish = resolve; });
    });
    const first = queue.stagePendingMemory(context, null, { content: "The active partition." });
    queue.releasePendingMemory(first, context);
    const second = queue.stagePendingMemory(other, vault, { content: "The new partition." });
    selected = other;
    queue.releasePendingMemory(second, other);
    finish();
    await settle();
    assert.equal(reads, 1);
    assert.deepEqual(sent, [
      [context.key, first.envelope.operation_id, null],
      [other.key, second.envelope.operation_id, vault],
    ]);
    assert.equal(timers.size, 0);
  `],
]) {
  test(name, async (t) => {
    const home = tempDir(t);
    const result = await run(process.execPath, ["--input-type=module", "--eval", bootstrap + scenario], {
      env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? "" },
      timeout: 15_000,
    });
    assert.equal(result.stdout, "");
  });
}
