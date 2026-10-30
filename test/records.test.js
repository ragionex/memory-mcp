import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { RULE_BODY } from "../build/init.js";
import { ACCOUNT_A, ACCOUNT_B, VAULT_A, VAULT_B, apiKey, connect, pause, pendingFiles, putProjectConfig, queueDirectory, startMock, tempDir, text, waitFor } from "./helpers.js";

const RECORD = {
  id: "mem_A",
  vault_id: VAULT_A,
  content: "The user prefers a dark theme.",
  created_at: "2026-09-26T08:30:00Z",
  updated_at: "2026-09-26T08:30:00Z",
  status: "ready",
  revision: 1,
  created_by: ACCOUNT_A,
  updated_by: ACCOUNT_A,
};

test("new and duplicate saves return the same metadata acknowledgement", async (t) => {
  const mock = await startMock(t);
  const home = tempDir(t);
  const client = await connect(t, { home, base: mock.base, key: apiKey("n") });
  const payload = { content: RECORD.content };
  const saved = await client.callTool({ name: "ragionex_save_memory", arguments: payload });
  const existing = await client.callTool({ name: "ragionex_save_memory", arguments: payload });
  for (const result of [saved, existing]) {
    assert.ok(!result.isError, text(result));
    assert.match(text(result), /^Saved record:\n/);
    const { content, ...acknowledgement } = mock.state.records.get("r1");
    assert.deepEqual(JSON.parse(text(result).replace(/^Saved record:\n/, "").split("\n\n\u26a0\ufe0f REMINDER TO CALLER:")[0]), acknowledgement);
    assert.doesNotMatch(text(result), /already exists|charged|queued|inserted/i);
  }
  assert.equal(mock.writes().length, 2);
  assert.deepEqual(mock.writes().map((request) => request.body), [payload, payload]);
  assert.deepEqual(pendingFiles(home), []);
  assert.equal(mock.state.records.size, 1);
});

test("list sends one bounded page request and preserves the cursor and date filters", async (t) => {
  const mock = await startMock(t);
  const client = await connect(t, { home: tempDir(t), base: mock.base, key: apiKey("n") });
  const cursor = "fixture-list-cursor";
  const row = { ...RECORD, content: "A preview." };
  mock.state.replies.list.push({ status: 200, body: { success: true, memories: [row], next_cursor: cursor } });
  const filters = { start_date: "2026-09-01", end_date: "2026-09-26", limit: 1 };
  const first = await client.callTool({ name: "ragionex_list_memories", arguments: filters });
  assert.deepEqual(JSON.parse(text(first).split("\n")[0].replace(/^\[1\] /, "")), row);
  assert.ok(text(first).includes(RECORD.created_at));
  assert.ok(text(first).includes(`next_cursor: "${cursor}"`));
  assert.match(text(first), /\n\n\u26a0\ufe0f REMINDER TO CALLER:\n- If the user said something newer than a record here, update that record\.\n- List text is cut short/);
  assert.doesNotMatch(text(first), /merge them/);
  let requests = mock.state.requests.filter((item) => item.method === "GET" && item.url.startsWith("/v1/memory/list?"));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body, undefined);
  assert.deepEqual(Object.fromEntries(new URL(requests[0].url, mock.base).searchParams), { limit: "1", start_date: "2026-09-01", end_date: "2026-09-26" });
  const last = await client.callTool({ name: "ragionex_list_memories", arguments: { ...filters, cursor } });
  assert.match(text(last), /No more records/);
  assert.match(text(last), /next_cursor: null/);
  assert.doesNotMatch(text(last), /REMINDER TO CALLER/);
  requests = mock.state.requests.filter((item) => item.method === "GET" && item.url.startsWith("/v1/memory/list?"));
  assert.equal(requests.length, 2);
  assert.deepEqual(Object.fromEntries(new URL(requests[1].url, mock.base).searchParams), { limit: "1", cursor, start_date: "2026-09-01", end_date: "2026-09-26" });
  const invalid = await client.callTool({ name: "ragionex_list_memories", arguments: { limit: 101 } });
  assert.equal(invalid.isError, true);
  const unknown = await client.callTool({ name: "ragionex_list_memories", arguments: { project: "acme-app" } });
  assert.equal(unknown.isError, true);
  assert.match(text(unknown), /Unrecognized key: "project"/);
  assert.equal(mock.state.requests.filter((item) => item.url.startsWith("/v1/memory/list?")).length, 2);
  mock.state.replies.list.push({ status: 200, body: { success: true, memories: [] } });
  const broken = await client.callTool({ name: "ragionex_list_memories", arguments: {} });
  assert.equal(broken.isError, true);
  assert.match(text(broken), /next_cursor/);
});

test("null date and cursor arguments mean no filter", async (t) => {
  const mock = await startMock(t);
  const client = await connect(t, { home: tempDir(t), base: mock.base, key: apiKey("q") });
  const recalled = await client.callTool({ name: "ragionex_recall_memory", arguments: { query: "Which theme does the user prefer?", page: null, start_date: null, end_date: null } });
  assert.ok(!recalled.isError, text(recalled));
  const search = mock.state.requests.find((item) => item.url === "/v1/memory/search");
  assert.deepEqual(search.body, { query: "Which theme does the user prefer?" });
  assert.equal(search.headers["x-ragionex-vault-id"], undefined);
  const listed = await client.callTool({ name: "ragionex_list_memories", arguments: { start_date: null, end_date: null, cursor: null } });
  assert.ok(!listed.isError, text(listed));
  assert.deepEqual(Object.fromEntries(new URL(mock.state.requests.find((item) => item.url.startsWith("/v1/memory/list?")).url, mock.base).searchParams), { limit: "50" });
});

test("date ranges compare like the service on any host time zone", async (t) => {
  const query = "Which theme does the user prefer?";
  const accepted = [
    ["2026-10-24T22:00:00", "2026-10-24"],
    ["2026-10-24", "2026-10-24T05:00:00"],
    ["2026-10-24T22:00:00", "2026-10-24T22:00:00Z"],
    ["2026-10-24T22:00:00-07:00", "2026-10-25"],
    ["2026-10-24T23:59:59.500Z", "2026-10-24"],
  ];
  const reversed = [
    ["2026-10-24T22:00:00", "2026-10-24T21:59:59Z"],
    ["2026-10-25", "2026-10-24T23:59:59"],
    ["2026-10-24T22:00:00-07:00", "2026-10-24"],
  ];
  for (const TZ of ["Etc/GMT+7", "Etc/GMT-14"]) {
    const mock = await startMock(t);
    const client = await connect(t, { home: tempDir(t), base: mock.base, key: apiKey("q"), env: { TZ } });
    for (const [start_date, end_date] of accepted) {
      const label = `${TZ} ${start_date} ${end_date}`;
      const recalled = await client.callTool({ name: "ragionex_recall_memory", arguments: { query, start_date, end_date } });
      assert.ok(!recalled.isError, `${label}: ${text(recalled)}`);
      assert.deepEqual(mock.state.requests.at(-1).body, { query, start_date, end_date }, label);
      const listed = await client.callTool({ name: "ragionex_list_memories", arguments: { start_date, end_date } });
      assert.ok(!listed.isError, `${label}: ${text(listed)}`);
      assert.deepEqual(Object.fromEntries(new URL(mock.state.requests.at(-1).url, mock.base).searchParams), { limit: "50", start_date, end_date }, label);
    }
    const sent = mock.state.requests.length;
    for (const [start_date, end_date] of reversed) {
      for (const [name, args] of [["ragionex_recall_memory", { query, start_date, end_date }], ["ragionex_list_memories", { start_date, end_date }]]) {
        const result = await client.callTool({ name, arguments: args });
        assert.equal(result.isError, true, `${TZ} ${name} ${start_date} ${end_date}`);
        assert.match(text(result), /must be >= start_date/);
      }
    }
    assert.equal(mock.state.requests.length, sent);
  }
});

test("failures that decide the next step say so inside the error", async (t) => {
  const mock = await startMock(t);
  const client = await connect(t, { home: tempDir(t), base: mock.base, key: apiKey("r") });
  const recall = () => client.callTool({ name: "ragionex_recall_memory", arguments: { query: "Which theme does the user prefer?" } });
  for (const [status, code, guidance] of [
    [500, "internal_error", /If this recall was the check before a save, save now anyway/],
    [429, "rate_limited", /If this recall was the check before a save, save now anyway/],
    [402, "quota_exceeded", /If this recall was the check before a save, save now anyway/],
    [403, "permission_denied", /If this recall was the check before a save, save without it/],
    [401, "unauthorized", /Show the user this step exactly as written/],
  ]) {
    mock.state.replies.search.push({ status, body: { success: false, error: "Rejected", code } });
    const result = await recall();
    assert.equal(result.isError, true);
    assert.match(text(result), guidance, String(status));
    assert.doesNotMatch(text(result), /REMINDER TO CALLER/, String(status));
  }
  mock.state.replies.search.push({ status: 422, body: { success: false, error: "Unknown field", code: "validation_error" } });
  assert.doesNotMatch(text(await recall()), /REMINDER TO CALLER/);
  mock.state.replies.update.push({ status: 403, body: { success: false, error: "Forbidden", code: "permission_denied" } });
  const denied = await client.callTool({ name: "ragionex_update_memory", arguments: { id: "mem_A", expected_revision: 1, content: "The user prefers a light theme." } });
  assert.match(text(denied), /Do not save a second copy/);
  assert.doesNotMatch(text(denied), /REMINDER TO CALLER/);
  mock.state.replies.write.push({ status: 500 });
  const queued = await client.callTool({ name: "ragionex_save_memory", arguments: { content: "The user prefers a light theme." } });
  assert.match(text(queued), /queued locally/);
  assert.match(text(queued), /no duplicate check was possible/);
  assert.doesNotMatch(text(queued), /[0-9a-f]{8}-[0-9a-f]{4}-|request ID/);
  assert.equal(mock.writes().length, 1);
  assert.equal(mock.state.requests.some(request => request.url === "/v1/memory/identity"), false);
});

test("successful results carry one reminder paragraph; errors carry their guidance inline", async (t) => {
  const mock = await startMock(t);
  const client = await connect(t, { home: tempDir(t), base: mock.base, key: apiKey("u") });
  const saved = await client.callTool({ name: "ragionex_save_memory", arguments: { content: "The user prefers a light theme." } });
  assert.match(text(saved), /\n\n\u26a0\ufe0f REMINDER TO CALLER:\n- If you did not try to recall this topic before saving, recall it now\./);
  const rows = [RECORD, { ...RECORD, id: "mem_B" }];
  mock.state.replies.search.push({ status: 200, body: { success: true, results: rows, next_cursor: null } });
  const overlapping = await client.callTool({ name: "ragionex_recall_memory", arguments: { query: "Which theme does the user prefer?" } });
  assert.match(text(overlapping), /\n\n\u26a0\ufe0f REMINDER TO CALLER:\n- If the user said something newer than a record here, update that record\.\n- If two records say the same thing, merge them into one\./);
  mock.state.replies.search.push({ status: 500, body: { success: false, error: "Internal error", code: "internal_error" } });
  const failed = await client.callTool({ name: "ragionex_recall_memory", arguments: { query: "Which theme does the user prefer?" } });
  assert.match(text(failed), / If this recall was the check before a save/);
  mock.state.replies.write.push({ status: 400, body: { success: false, error: "Memory content exceeds your plan's 10000-character limit.", code: "content_too_long" } });
  const tooLong = await client.callTool({ name: "ragionex_save_memory", arguments: { content: "x".repeat(20) } });
  assert.equal(tooLong.isError, true);
  assert.match(text(tooLong), /Nothing was saved\. Split the content into as few parts as the limit allows/);
  assert.doesNotMatch(text(tooLong), /REMINDER TO CALLER/);
  assert.match(text(tooLong), /Never summarize to make it fit/);
});

test("the setup command names the connected agent", async (t) => {
  const mock = await startMock(t);
  const client = await connect(t, { home: tempDir(t), base: mock.base, key: apiKey("s"), name: "codex-mcp-client" });
  await pause(500);
  mock.state.replies.search.push({ status: 401, body: { success: false, error: "Unauthorized", code: "unauthorized" } });
  const result = await client.callTool({ name: "ragionex_recall_memory", arguments: { query: "Which theme does the user prefer?" } });
  assert.match(text(result), /Run the setup: npx -y @ragionex\/memory-mcp@latest install --agent codex/);
});

test("view and delete send JSON ids and preserve ordered all-or-none batches", async (t) => {
  const mock = await startMock(t);
  mock.state.records.set("mem_A", RECORD);
  mock.state.records.set("mem_B", { ...RECORD, id: "mem_B" });
  const client = await connect(t, { home: tempDir(t), base: mock.base, key: apiKey("n") });
  const viewed = await client.callTool({ name: "ragionex_view_memory", arguments: { ids: ["mem_B", "mem_A", "mem_B"] } });
  assert.ok(!viewed.isError, text(viewed));
  assert.ok(text(viewed).indexOf('"mem_B"') < text(viewed).indexOf('"mem_A"'));
  assert.equal((text(viewed).match(/"id": "mem_B"/g) ?? []).length, 1);
  const request = mock.state.requests.find((item) => item.url === "/v1/memory/view");
  assert.equal(request.method, "POST");
  assert.deepEqual(request.body, { ids: ["mem_B", "mem_A", "mem_B"] });
  const missing = await client.callTool({ name: "ragionex_view_memory", arguments: { ids: ["mem_A", "mem_MISSING"] } });
  assert.equal(missing.isError, true);
  assert.match(text(missing), /\["mem_MISSING"\]/);
  assert.match(text(missing), /No records were returned or deleted/);
  assert.equal(text(missing).includes(RECORD.content), false);
  const failed = await client.callTool({ name: "ragionex_delete_memory", arguments: { ids: ["mem_A", "mem_MISSING"] } });
  assert.equal(failed.isError, true);
  assert.equal(mock.state.records.has("mem_A"), true);
  const removed = await client.callTool({ name: "ragionex_delete_memory", arguments: { ids: ["mem_A", "mem_A"] } });
  assert.match(text(removed), /Moved 1 memory to trash/);
  const deletes = mock.state.requests.filter((item) => item.url === "/v1/memory/delete");
  assert.equal(deletes.length, 2);
  assert.ok(deletes.every((item) => item.method === "DELETE"));
  assert.deepEqual(deletes.map((item) => item.body), [{ ids: ["mem_A", "mem_MISSING"] }, { ids: ["mem_A", "mem_A"] }]);
  assert.equal(mock.state.records.has("mem_B"), true);
});

test("invalid record ids never reach the API", async (t) => {
  const mock = await startMock(t);
  const client = await connect(t, { home: tempDir(t), base: mock.base, key: apiKey("n") });
  for (const [name, args] of [
    ["ragionex_view_memory", { ids: ["bad/id"] }],
    ["ragionex_delete_memory", { ids: ["bad id"] }],
    ["ragionex_update_memory", { id: "bad-id", expected_revision: 1, content: "A revised fact." }],
    ["ragionex_memory_status", { id: "bad?id" }],
  ]) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, name);
  }
  assert.deepEqual(mock.state.requests, []);
});

test("view keeps whole records and names every omitted id", async (t) => {
  const mock = await startMock(t);
  const client = await connect(t, { home: tempDir(t), base: mock.base, key: apiKey("o") });
  const rows = [
    { ...RECORD, content: "x".repeat(40000) },
    { ...RECORD, id: "mem_B", content: "y".repeat(40000) },
    { ...RECORD, id: "mem_C", content: "A final fact." },
  ];
  mock.state.replies.view.push({ status: 200, body: { success: true, memories: rows } });
  const viewed = await client.callTool({ name: "ragionex_view_memory", arguments: { ids: rows.map((row) => row.id) } });
  assert.deepEqual(JSON.parse(text(viewed).split("\n\n")[0]), rows[0]);
  assert.match(text(viewed), /Omitted record IDs: \["mem_B","mem_C"\]/);
  const huge = { ...RECORD, content: "\\".repeat(40000) };
  mock.state.replies.view.push({ status: 200, body: { success: true, memories: [huge] } });
  const single = await client.callTool({ name: "ragionex_view_memory", arguments: { ids: ["mem_A"] } });
  assert.deepEqual(JSON.parse(text(single).split("\n\n")[0]), huge);
  assert.match(text(single), /shown in full/);
  assert.equal(Object.hasOwn(single, "structuredContent"), false);
});

test("every tool result uses text without a structured duplicate", async (t) => {
  const mock = await startMock(t);
  const client = await connect(t, { home: tempDir(t), base: mock.base, key: apiKey("o") });
  mock.state.records.set(RECORD.id, RECORD);
  const calls = [
    ["ragionex_memory_connection", {}],
    ["ragionex_save_memory", { content: "A different fact." }],
    ["ragionex_recall_memory", { query: "Which theme does the user prefer?" }],
    ["ragionex_list_memories", {}],
    ["ragionex_view_memory", { ids: [RECORD.id] }],
    ["ragionex_update_memory", { id: RECORD.id, expected_revision: RECORD.revision, content: RECORD.content }, "update", { success: true, ...RECORD }],
    ["ragionex_memory_status", { id: RECORD.id }, "status", { success: true, id: RECORD.id, status: "ready", revision: 1, updated_at: RECORD.updated_at, message: "This memory is processed and searchable." }],
    ["ragionex_delete_memory", { ids: [RECORD.id] }],
    ["ragionex_list_trash", {}],
    ["ragionex_memory_versions", { id: RECORD.id }, "versions", {
      success: true, current_revision: 2, versions: [{ ...RECORD, operation: "create",
        restored_from_revision: null, expires_at: "2026-10-02T00:00:00Z", is_current: false }], next_cursor: null,
    }],
    ["ragionex_restore_memory", { id: RECORD.id, expected_revision: 2, revision: null }, "restore",
      { success: true, ...RECORD, revision: 3, status: "processing" }],
  ];
  for (const [name, args, route, body] of calls) {
    if (route) mock.state.replies[route].push({ status: 200, body });
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, `${name}: ${text(result)}`);
    assert.equal(Object.hasOwn(result, "structuredContent"), false, name);
    assert.ok(text(result).length > 0, name);
  }
  mock.state.replies.write.push({ status: 500 });
  const queued = await client.callTool({ name: "ragionex_save_memory", arguments: { content: "Wait for delivery." } });
  assert.match(text(queued), /queued locally/);
  assert.equal(Object.hasOwn(queued, "structuredContent"), false);
});

test("public errors keep actionable fields and reads are never retried automatically", async (t) => {
  const mock = await startMock(t);
  const client = await connect(t, { home: tempDir(t), base: mock.base, key: apiKey("p") });
  const cases = [
    { status: 401, body: { success: false, error: "Unauthorized", code: "unauthorized" }, match: /Create a key at https:\/\/app\.ragionex\.com\/keys and add it to this client's MCP configuration/, support: false },
    { status: 402, body: { success: false, error: "Unavailable", code: "payg_unavailable" }, match: /Pay-as-you-go is currently unavailable/, support: false },
    { status: 402, body: { success: false, error: "Quota reached", code: "quota_exceeded" }, match: /plan limit/, support: false },
    { status: 429, headers: { "Retry-After": "7" }, body: { success: false, error: "Rate limited", code: "rate_limited", retry_after_seconds: 12 }, match: /Retry after 7 seconds/, support: false },
    { status: 429, body: { success: false, error: "Rate limited", code: "rate_limited", retry_after_seconds: 9 }, match: /Retry after 9 seconds/, support: false },
    { status: 503, headers: { "Retry-After": "4" }, body: { success: false, error: "Busy", code: "busy" }, match: /temporarily unavailable\. Retry after 4 seconds/, support: false },
    { status: 503, headers: { "Retry-After": "5" }, body: { success: false, error: "Unavailable", code: "auth_unavailable" }, match: /temporarily unavailable\. Retry after 5 seconds/, support: false },
    { status: 500, body: { success: false, error: "Internal error", code: "internal_error" }, match: /memory service failed/, support: true },
    { status: 422, body: { success: false, error: "Unknown field", code: "validation_error", errors: [{ field: "request", message: "Unknown field" }] }, match: /validation_error/, support: false },
  ];
  for (const scenario of cases) {
    const before = mock.state.requests.filter((item) => item.url === "/v1/memory/search").length;
    mock.state.replies.search.push(scenario);
    const result = await client.callTool({ name: "ragionex_recall_memory", arguments: { query: "Which theme does the user prefer?" } });
    assert.equal(result.isError, true);
    assert.match(text(result), scenario.match);
    assert.equal(text(result).includes("https://github.com/ragionex/memory-mcp#support"), scenario.support);
    assert.doesNotMatch(text(result), /No records matched/);
    assert.equal(mock.state.requests.filter((item) => item.url === "/v1/memory/search").length, before + 1);
  }
  for (const name of ["ragionex_view_memory", "ragionex_delete_memory"]) {
    const result = await client.callTool({ name, arguments: { ids: ["mem_MISSING"] } });
    assert.equal(result.isError, true);
    assert.match(text(result), /\["mem_MISSING"\]/);
    assert.match(text(result), /No records were returned or deleted/);
  }
});

test("recall waits for a delayed result when the client allows long tool calls", { timeout: 135_000 }, async (t) => {
  const mock = await startMock(t);
  const home = tempDir(t);
  const client = await connect(t, { home, base: mock.base, key: apiKey("x") });
  mock.state.replies.search.push({
    status: 200,
    delayMs: 65_000,
    body: { success: true, results: [RECORD], next_cursor: null },
  });
  const result = await client.callTool(
    {
      name: "ragionex_recall_memory",
      arguments: { query: "Which theme does the user prefer?" },
    },
    undefined,
    { timeout: 130_000 },
  );
  assert.notEqual(result.isError, true);
  assert.match(text(result), /"id":\s*"mem_A"/);
  assert.equal(mock.state.requests.filter((item) => item.url === "/v1/memory/search").length, 1);
  assert.deepEqual(pendingFiles(home), []);
});

test("a repaired acknowledgement failure retries the original save without a restart", { skip: process.getuid?.() === 0 || process.platform === "win32" }, async (t) => {
  const mock = await startMock(t);
  const home = tempDir(t);
  const key = apiKey("p");
  const client = await connect(t, { home, base: mock.base, key });
  const folder = queueDirectory(home, mock.base, key);
  mock.state.onWrite = () => {
    fs.chmodSync(folder, 0o500);
    mock.state.onWrite = null;
  };
  let saved;
  try {
    saved = await client.callTool({ name: "ragionex_save_memory", arguments: { content: "Keep this accepted save." } });
  } finally {
    fs.chmodSync(folder, 0o700);
  }
  assert.match(text(saved), /Server acceptance is confirmed/);
  const [file] = pendingFiles(home);
  const envelope = JSON.parse(fs.readFileSync(file, "utf-8"));
  await client.callTool({ name: "ragionex_memory_connection", arguments: {} });
  assert.ok(await waitFor(() => pendingFiles(home).length === 0));
  assert.equal(mock.writes().length, 2);
  assert.ok(mock.writes().every(request => request.headers["idempotency-key"] === envelope.operation_id));
  const next = await client.callTool({ name: "ragionex_save_memory", arguments: { content: "A later save succeeds." } });
  assert.match(text(next), /Saved record:/);
  const report = JSON.parse(text(await client.callTool({ name: "ragionex_memory_connection", arguments: {} })));
  assert.equal(report.queue.storage_error, null);
  assert.equal(mock.state.records.size, 2);
  assert.equal(mock.state.charges, 2);
});

test("connection starts a background sync without waiting for its send", async (t) => {
  const mock = await startMock(t);
  const home = tempDir(t);
  const client = await connect(t, { home, base: mock.base, key: apiKey("q") });
  await client.callTool({ name: "ragionex_memory_connection", arguments: {} });
  mock.state.replies.write.push({ status: 500 });
  await client.callTool({ name: "ragionex_save_memory", arguments: { content: "Sync after reconnect." } });
  assert.equal(pendingFiles(home).length, 1);
  mock.state.replies.write.push({
    status: 200,
    delayMs: 1000,
    body: { success: true, ...RECORD, id: "mem_RETRY", content: "Sync after reconnect.", status: "processing" },
  });
  const result = await client.callTool({ name: "ragionex_memory_connection", arguments: {} });
  const data = JSON.parse(text(result));
  assert.match(data.sync, /started in the background/);
  assert.match(data.sync, /does not confirm/);
  assert.equal(pendingFiles(home).length, 1);
  assert.ok(await waitFor(() => mock.writes().length === 2));
  assert.equal(mock.writes()[0].headers["idempotency-key"], mock.writes()[1].headers["idempotency-key"]);
  const already = JSON.parse(text(await client.callTool({ name: "ragionex_memory_connection", arguments: {} })));
  assert.match(already.sync, /No new sync started/);
  assert.ok(await waitFor(() => pendingFiles(home).length === 0));
  const idle = JSON.parse(text(await client.callTool({ name: "ragionex_memory_connection", arguments: {} })));
  assert.match(idle.sync, /No new sync started/);
});

test("server instructions and the rule body keep their calibrated pointers and examples", async (t) => {
  const mock = await startMock(t);
  const client = await connect(t, { home: tempDir(t), base: mock.base, key: apiKey("q") });
  const instructions = client.getInstructions();
  assert.match(instructions, /For browsing without a topic, use ragionex_list_memories\./);
  assert.match(instructions, /The priority rule in the user's agent rules file defines the full behavior\./);
  assert.match(instructions, /Before every save, recall the topic once without date filters/);
  assert.match(RULE_BODY, /preferences, decisions and project facts/);
  assert.match(RULE_BODY, /### BEFORE EVERY SAVE: RECALL/);
  assert.ok(RULE_BODY.includes("ragionex_save_memory(content='pixelforge uses Postgres for its main database.')"));
  assert.ok(RULE_BODY.includes("ragionex_save_memory(content='acme-app runs CI on GitHub Actions and deploys automatically on merge.')"));
});

test("malformed record deletion counts remain errors", async (t) => {
  const mock = await startMock(t);
  const client = await connect(t, { home: tempDir(t), base: mock.base, key: apiKey("r") });
  mock.state.replies.delete.push({ status: 200, body: { success: true, deleted: "one" } });
  const result = await client.callTool({ name: "ragionex_delete_memory", arguments: { ids: ["mem_A"] } });
  assert.equal(result.isError, true);
  assert.match(text(result), /no valid deleted count/);
});

test("status passes through public guidance without a completion promise", async (t) => {
  assert.doesNotMatch(RULE_BODY, /searchable shortly/);
  const mock = await startMock(t);
  const client = await connect(t, { home: tempDir(t), base: mock.base, key: apiKey("r") });
  for (const [status, message] of [
    ["processing", "This memory is being processed and becomes searchable when processing finishes."],
    ["failed", "This memory could not be processed. Update its content to try again."],
  ]) {
    mock.state.replies.status.push({ status: 200, body: { success: true, id: "mem_A", status, revision: 1, updated_at: RECORD.created_at, message } });
    const result = await client.callTool({ name: "ragionex_memory_status", arguments: { id: "mem_A" } });
    assert.ok(text(result).includes(message));
    assert.doesNotMatch(text(result), /shortly/);
    assert.match(text(result), /Report this status; do not promise when processing will finish/);
  }
});

test("malformed read records and update acknowledgements are errors", async (t) => {
  const mock = await startMock(t);
  const home = tempDir(t);
  const client = await connect(t, { home, base: mock.base, key: apiKey("t") });
  const missingCreator = { ...RECORD };
  delete missingCreator.created_by;
  for (const record of [
    missingCreator,
    { ...RECORD, updated_at: null },
    { ...RECORD, revision: 0 },
  ]) {
    for (const [route, name, args, body] of [
      ["search", "ragionex_recall_memory", { query: "Which theme does the user prefer?" }, { success: true, results: [record], next_cursor: null }],
      ["list", "ragionex_list_memories", {}, { success: true, memories: [record], next_cursor: null }],
      ["view", "ragionex_view_memory", { ids: [RECORD.id] }, { success: true, memories: [record] }],
      ["update", "ragionex_update_memory", { id: RECORD.id, expected_revision: 1, content: RECORD.content }, { success: true, ...record }],
    ]) {
      mock.state.replies[route].push({ status: 200, body });
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true, name);
      assert.doesNotMatch(text(result), /No records matched|No records were returned|queued locally/);
    }
  }
  assert.equal(mock.state.requests.filter((request) => request.method === "PUT").length, 3);
  assert.deepEqual(pendingFiles(home), []);
});

test("record surfaces keep account actors and drop extra response fields", async (t) => {
  const mock = await startMock(t);
  const home = tempDir(t);
  const client = await connect(t, { home, base: mock.base, key: apiKey("t") });
  const record = { ...RECORD, updated_by: ACCOUNT_B };
  const { content, ...acknowledgement } = record;
  const extended = { ...record, extra_fixture: "hidden", future_field: { enabled: true } };
  for (const [route, name, args, body] of [
    ["write", "ragionex_save_memory", { content: record.content }, { success: true, ...extended }],
    ["search", "ragionex_recall_memory", { query: "Which theme does the user prefer?" }, { success: true, results: [extended], next_cursor: null }],
    ["list", "ragionex_list_memories", {}, { success: true, memories: [extended], next_cursor: null }],
    ["view", "ragionex_view_memory", { ids: [record.id] }, { success: true, memories: [extended] }],
    ["update", "ragionex_update_memory", { id: record.id, expected_revision: record.revision, content: record.content }, { success: true, ...extended }],
  ]) {
    mock.state.replies[route].push({ status: 200, body });
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, `${name}: ${text(result)}`);
    const rendered = route === "search" || route === "list"
      ? text(result).split("\n")[0].replace(/^\[1\] /, "")
      : text(result).replace(/^(?:Saved|Updated) record:\n/, "").split("\n\n\u26a0\ufe0f REMINDER TO CALLER:")[0];
    assert.deepEqual(JSON.parse(rendered), route === "write" || route === "update" ? acknowledgement : record, name);
    assert.equal(Object.hasOwn(result, "structuredContent"), false, name);
  }
  assert.equal(mock.writes().length, 1);
  assert.deepEqual(mock.writes()[0].body, { content: record.content });
  assert.deepEqual(pendingFiles(home), []);
});

test("ordinary record operations use header or live default without identity discovery", async (t) => {
  const mock = await startMock(t);
  mock.state.identity.vaults.push({ ...mock.state.identity.vaults[0], vault_id: VAULT_B, vault_name: "Acme", is_default: false });
  const home = tempDir(t);
  const client = await connect(t, { home, base: mock.base, key: apiKey("n") });
  for (const target of [VAULT_A, VAULT_B]) {
    if (target === VAULT_B) putProjectConfig(home, { vault_id: target });
    const record = { ...RECORD, vault_id: target };
    mock.state.records.set(record.id, record);
    const { content, ...acknowledgement } = record;
    mock.state.replies.update.push({ status: 200, body: { success: true, ...acknowledgement } });
    mock.state.replies.status.push({ status: 200, body: { success: true, id: record.id, status: "ready" } });
    for (const [name, args] of [
      ["ragionex_list_memories", {}],
      ["ragionex_view_memory", { ids: [record.id] }],
      ["ragionex_update_memory", { id: record.id, expected_revision: 1, content: record.content }],
      ["ragionex_memory_status", { id: record.id }],
      ["ragionex_delete_memory", { ids: [record.id] }],
    ]) {
      const result = await client.callTool({ name, arguments: args });
      assert.ok(!result.isError, `${name}: ${text(result)}`);
      assert.equal(mock.state.requests.at(-1).headers["x-ragionex-vault-id"], target === VAULT_A ? undefined : target);
    }
  }
  assert.equal(mock.state.requests.length, 10);
  assert.equal(mock.state.requests.some(request => request.url === "/v1/memory/identity"), false);
});
