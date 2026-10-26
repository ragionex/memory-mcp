import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { responseBudgetForClient } from "../build/init.js";
import {
  ACCOUNT_A, VAULT_A, VAULT_B, apiKey, connect, putProjectConfig,
  queueDirectory, startMock, tempDir, text,
} from "./helpers.js";

const QUESTION = "Which deployment rules does acme-app use?";
const RECORD = {
  id: "r01", vault_id: VAULT_A, content: "A deployment rule.",
  created_at: "2026-09-26T08:30:00Z", updated_at: "2026-09-26T08:30:00Z",
  status: "ready", revision: 1, created_by: ACCOUNT_A, updated_by: ACCOUNT_A,
};
const recall = (client, args = {}) => client.callTool({
  name: "ragionex_recall_memory", arguments: { query: QUESTION, ...args },
});
const searches = (mock) => mock.state.requests.filter(request => request.url === "/v1/memory/search");
const records = (count, size = 14_000, prefix = "r") => Array.from({ length: count }, (_, offset) => {
  const id = `${prefix}${String(offset + 1).padStart(2, "0")}`;
  return { ...RECORD, id, content: `DETAIL_${id} ${"x".repeat(size)}` };
});

function rendered(result) {
  assert.ok(!result.isError, text(result));
  return text(result).split("\n\n")
    .filter(part => /^\[\d+\] /.test(part))
    .map(part => JSON.parse(part.replace(/^\[\d+\] /, "")));
}

const serviceCursor = (offset) => `fixture-${offset}-${"x".repeat(1024)}`;

function serveSearch(mock, rows) {
  const offsets = new Map();
  mock.state.onSearch = (body, vault) => {
    const offset = body.cursor === undefined ? 0 : offsets.get(body.cursor);
    if (offset === undefined) {
      return { status: 400, body: { success: false, code: "invalid_cursor", error: "Invalid continuation." } };
    }
    const available = rows.filter(row => row.vault_id === vault.vault_id);
    const results = available.slice(offset, offset + 10);
    const nextOffset = offset + results.length;
    const nextCursor = nextOffset < available.length ? serviceCursor(nextOffset) : null;
    if (nextCursor !== null) offsets.set(nextCursor, nextOffset);
    return { status: 200, body: { success: true, results, next_cursor: nextCursor } };
  };
}

function stored(home, base, key) {
  const folder = path.join(home, ".ragionex", "recall-pages", path.basename(queueDirectory(home, base, key)));
  const files = fs.readdirSync(folder);
  assert.equal(files.length, 1);
  assert.match(files[0], /^[a-f0-9]{64}\.json$/);
  return JSON.parse(fs.readFileSync(path.join(folder, files[0]), "utf8"));
}

function checkResult(result, budget) {
  const rows = rendered(result);
  assert.ok(rows.length > 0);
  assert.ok(Buffer.byteLength(text(result), "utf8") <= budget);
  assert.equal(text(result).split("\u26a0\ufe0f REMINDER TO CALLER:").length - 1, 1);
  assert.doesNotMatch(text(result), /Omitted record IDs|sub.?page|\bbudgets?\b|\bbytes?\b|\brequests?\b|\bcredits?\b/i);
  assert.ok(text(result).split("\n").length < 100);
  return rows;
}

test("budgets use exact handshake identities and include UTF-8, escaping and reminders", async (t) => {
  assert.equal(responseBudgetForClient(undefined), 30_000);
  assert.equal(responseBudgetForClient({ name: "codex" }), 30_000);
  for (const [name, budget, count] of [
    ["claude-code", 45_000, 4], ["opencode", 45_000, 4],
    ["codex-mcp-client", 35_000, 3], ["test-client", 30_000, 2],
  ]) {
    await t.test(name, async (t) => {
      assert.equal(responseBudgetForClient({ name }), budget);
      const mock = await startMock(t);
      const home = tempDir(t);
      const rows = records(10).map(row => ({
        ...row, content: `DETAIL_${row.id} ${String.fromCodePoint(0x2603).repeat(3000)}${"\\\n".repeat(200)}`,
      }));
      serveSearch(mock, rows);
      const client = await connect(t, { home, base: mock.base, key: apiKey("b"), name });
      const first = await recall(client);
      assert.deepEqual(checkResult(first, budget), rows.slice(0, count));
      assert.equal(searches(mock).length, 1);
      const second = await recall(client, { page: 2 });
      assert.deepEqual(checkResult(second, budget), rows.slice(count, Math.min(count * 2, rows.length)));
      assert.equal(searches(mock).length, 1);
    });
  }
});

test("the complete response fits exactly at the ceiling and splits one byte above it", async (t) => {
  const mock = await startMock(t);
  const rows = records(2, 12_000);
  serveSearch(mock, rows);
  const client = await connect(t, { home: tempDir(t), base: mock.base, key: apiKey("b") });
  const initial = await recall(client);
  assert.deepEqual(rendered(initial), rows);
  rows[0].content += "x".repeat(30_000 - Buffer.byteLength(text(initial), "utf8"));
  const exact = await recall(client);
  assert.deepEqual(checkResult(exact, 30_000), rows);
  assert.equal(Buffer.byteLength(text(exact), "utf8"), 30_000);
  rows[0].content += "x";
  const split = await recall(client);
  assert.deepEqual(checkResult(split, 30_000), rows.slice(0, 1));
  assert.doesNotMatch(text(split), /merge them/);
  assert.match(text(split), /page=2\./);
  const before = searches(mock).length;
  assert.deepEqual(checkResult(await recall(client, { page: 2 }), 30_000), rows.slice(1));
  assert.equal(searches(mock).length, before);
});

test("restart refetches the first service page with the original dates and no stored text", async (t) => {
  const mock = await startMock(t);
  const home = tempDir(t);
  const key = apiKey("r");
  putProjectConfig(home, { vault_id: VAULT_A });
  const rows = records(8);
  serveSearch(mock, rows);
  const dates = { start_date: "2026-09-01", end_date: "2026-09-30" };
  const first = await connect(t, { home, base: mock.base, key });
  assert.deepEqual(checkResult(await recall(first, dates), 30_000), rows.slice(0, 2));
  const state = stored(home, mock.base, key);
  assert.deepEqual(Object.keys(state).sort(), ["pages", "saved_at"]);
  assert.deepEqual(state.pages, { 2: "|r01.r02" });
  const serialized = JSON.stringify(state);
  for (const secret of [QUESTION, "deployment rules", key, "DETAIL_", rows[0].content, rows[7].content]) {
    assert.equal(serialized.includes(secret), false);
  }
  await first.close();
  const second = await connect(t, { home, base: mock.base, key });
  const resumed = await recall(second, { ...dates, page: 2 });
  assert.deepEqual(checkResult(resumed, 30_000), rows.slice(2, 4));
  assert.deepEqual(searches(mock).at(-1).body, { query: QUESTION, ...dates });
  assert.equal(searches(mock).at(-1).headers["x-ragionex-vault-id"], VAULT_A);
  assert.equal(searches(mock).length, 2);
  assert.deepEqual(checkResult(await recall(second, { ...dates, page: 3 }), 30_000), rows.slice(4, 6));
  assert.equal(searches(mock).length, 2);
});

test("split first, later and final service pages keep their original fetch cursor across restarts", async (t) => {
  for (const restart of [false, true]) {
    await t.test(restart ? "restart between split pages" : "stay in one process", async (t) => {
      const mock = await startMock(t);
      const home = tempDir(t);
      const key = apiKey("f");
      const rows = records(30);
      serveSearch(mock, rows);
      let client = await connect(t, { home, base: mock.base, key });
      const seen = [];
      const restartAfter = new Set([2, 7, 12]);
      const totalPages = rows.length / 2;
      let fetches = 0;
      for (let page = 1; page <= totalPages; page++) {
        const result = await recall(client, { page });
        const current = checkResult(result, 30_000);
        assert.deepEqual(current, rows.slice((page - 1) * 2, page * 2));
        seen.push(...current.map(row => row.id));
        const serviceStart = Math.floor((page - 1) / 5) * 10;
        const originalCursor = serviceStart === 0 ? undefined : serviceCursor(serviceStart);
        if ((page - 1) % 5 === 0 || (restart && restartAfter.has(page - 1))) {
          fetches++;
          assert.deepEqual(searches(mock).at(-1).body, {
            query: QUESTION, ...(originalCursor === undefined ? {} : { cursor: originalCursor }),
          });
        }
        assert.equal(searches(mock).length, fetches);
        const state = stored(home, mock.base, key);
        assert.ok(Object.values(state.pages).every(value => value === null || typeof value === "string"));
        assert.equal(JSON.stringify(state).includes("DETAIL_"), false);
        if (page < totalPages) {
          assert.match(text(result), new RegExp(`page=${page + 1}\\.`));
          assert.doesNotMatch(text(result), /no more pages/);
          const next = page % 5 === 0
            ? serviceCursor(page * 2)
            : `${originalCursor ?? ""}|${rows.slice(serviceStart, page * 2).map(row => row.id).join(".")}`;
          assert.equal(state.pages[String(page + 1)], next);
        } else {
          assert.match(text(result), /This search has no more pages\./);
          assert.doesNotMatch(text(result), /page=16|Stop paging/);
          assert.equal(state.pages[String(page + 1)], null);
        }
        if (restart && restartAfter.has(page)) {
          await client.close();
          client = await connect(t, { home, base: mock.base, key });
        }
      }
      assert.equal(new Set(seen).size, rows.length);
      assert.equal(searches(mock).length, restart ? 6 : 3);
      const before = searches(mock).length;
      for (const page of [totalPages + 1, totalPages * 2]) {
        const ended = await recall(client, { page });
        assert.match(text(ended), /^This search has no more pages\./);
        assert.doesNotMatch(text(ended), /\u26a0\ufe0f REMINDER TO CALLER:|No records matched/);
      }
      assert.equal(searches(mock).length, before);
    });
  }
});

test("ordinary pages forward long opaque service-issued continuations unchanged", async (t) => {
  const mock = await startMock(t);
  const home = tempDir(t);
  const key = apiKey("p");
  const rows = records(100, 1);
  serveSearch(mock, rows);
  const client = await connect(t, { home, base: mock.base, key });
  const totalPages = rows.length / 10;
  let previousCursor;
  for (let page = 1; page <= totalPages; page++) {
    const result = await recall(client, { page });
    assert.deepEqual(checkResult(result, 30_000), rows.slice((page - 1) * 10, page * 10));
    assert.deepEqual(searches(mock).at(-1).body, {
      query: QUESTION, ...(previousCursor === undefined ? {} : { cursor: previousCursor }),
    });
    const nextCursor = page < totalPages ? serviceCursor(page * 10) : null;
    assert.equal(stored(home, mock.base, key).pages[String(page + 1)], nextCursor);
    previousCursor = nextCursor;
  }
  assert.equal(searches(mock).length, totalPages);
  assert.ok(searches(mock).at(-1).body.cursor.length > 1024);
});

test("an empty service page after a split ends the search even if it carries a cursor", async (t) => {
  const mock = await startMock(t);
  const rows = records(10);
  mock.state.replies.search.push({ status: 200, body: { success: true, results: rows, next_cursor: "fixture-next" } });
  const client = await connect(t, { home: tempDir(t), base: mock.base, key: apiKey("e") });
  for (let page = 1; page <= 5; page++) {
    assert.deepEqual(checkResult(await recall(client, { page }), 30_000), rows.slice((page - 1) * 2, page * 2));
  }
  assert.equal(searches(mock).length, 1);
  mock.state.replies.search.push({ status: 200, body: { success: true, results: [], next_cursor: "fixture-empty" } });
  const empty = await recall(client, { page: 6 });
  assert.ok(!empty.isError);
  assert.equal(text(empty), "No more records were returned for this search. Use the records from earlier pages; this does not mean nothing was found.");
  assert.doesNotMatch(text(empty), /\u26a0\ufe0f REMINDER TO CALLER:|No records matched|page=|save it now/);
  assert.equal(searches(mock).length, 2);
  assert.match(text(await recall(client, { page: 7 })), /^This search has no more pages\./);
  assert.equal(searches(mock).length, 2);
});

test("an oversized record is returned alone and the next record still arrives from memory", async (t) => {
  const mock = await startMock(t);
  const rows = [
    { ...RECORD, content: `${"\\".repeat(60_000)} END_OF_RECORD` },
    { ...RECORD, id: "r02", content: "A later rule." },
  ];
  serveSearch(mock, rows);
  const client = await connect(t, { home: tempDir(t), base: mock.base, key: apiKey("o") });
  const first = await recall(client);
  assert.deepEqual(rendered(first), rows.slice(0, 1));
  assert.ok(Buffer.byteLength(text(first), "utf8") > 100_000);
  assert.match(text(first), /END_OF_RECORD/);
  assert.match(text(first), /page=2\./);
  assert.equal(text(first).split("\u26a0\ufe0f REMINDER TO CALLER:").length - 1, 1);
  assert.doesNotMatch(text(first), /Omitted record IDs|none fit/);
  const second = await recall(client, { page: 2 });
  assert.deepEqual(checkResult(second, 30_000), rows.slice(1));
  assert.match(text(second), /This search has no more pages\./);
  assert.equal(searches(mock).length, 1);
});

test("refetching an earlier page invalidates both later continuations and its remainder", async (t) => {
  const mock = await startMock(t);
  const home = tempDir(t);
  const key = apiKey("i");
  const oldRows = records(10, 14_000, "a");
  serveSearch(mock, oldRows);
  const client = await connect(t, { home, base: mock.base, key });
  await recall(client);
  assert.deepEqual(rendered(await recall(client, { page: 2 })), oldRows.slice(2, 4));
  const newRows = records(10, 14_000, "b");
  serveSearch(mock, newRows);
  assert.deepEqual(rendered(await recall(client)), newRows.slice(0, 2));
  assert.deepEqual(stored(home, mock.base, key).pages, { 2: "|b01.b02" });
  const early = await recall(client, { page: 3 });
  assert.equal(early.isError, true);
  assert.match(text(early), /Call ragionex_recall_memory for page 2 first/);
  const before = searches(mock).length;
  assert.deepEqual(rendered(await recall(client, { page: 2 })), newRows.slice(2, 4));
  assert.equal(searches(mock).length, before);
});

test("connectors sharing a file continue their own in-memory records", async (t) => {
  const mock = await startMock(t);
  const home = tempDir(t);
  const key = apiKey("c");
  const left = await connect(t, { home, base: mock.base, key });
  const right = await connect(t, { home, base: mock.base, key });
  const leftRows = records(4, 14_000, "a");
  const rightRows = records(4, 14_000, "b");
  mock.state.replies.search.push({ status: 200, body: { success: true, results: leftRows, next_cursor: null } });
  await recall(left);
  mock.state.replies.search.push({ status: 200, body: { success: true, results: rightRows, next_cursor: null } });
  await recall(right);
  assert.deepEqual(stored(home, mock.base, key).pages, { 2: "|b01.b02" });
  const [a, b] = await Promise.all([recall(left, { page: 2 }), recall(right, { page: 2 })]);
  assert.deepEqual(rendered(a), leftRows.slice(2));
  assert.deepEqual(rendered(b), rightRows.slice(2));
  assert.equal(searches(mock).length, 2);
});

test("a changed key or explicit Vault cannot consume another selection's remainder", async (t) => {
  const mock = await startMock(t);
  const home = tempDir(t);
  const key = apiKey("v");
  const rows = records(4);
  serveSearch(mock, rows);
  putProjectConfig(home, { vault_id: VAULT_A });
  const client = await connect(t, { home, base: mock.base, key });
  await recall(client);
  for (const selection of [
    { vault_id: VAULT_B }, { vault_id: VAULT_A, api_key: apiKey("w") },
  ]) {
    putProjectConfig(home, selection);
    const result = await recall(client, { page: 2 });
    assert.equal(result.isError, true);
    assert.match(text(result), /Call ragionex_recall_memory for page 1 first/);
  }
  putProjectConfig(home, { vault_id: VAULT_A });
  assert.deepEqual(rendered(await recall(client, { page: 2 })), rows.slice(2));
  assert.equal(searches(mock).length, 1);
});

test("cached pages are snapshots while the next fetch follows a changed account default", async (t) => {
  const mock = await startMock(t);
  const rows = records(10);
  mock.state.replies.search.push({ status: 200, body: { success: true, results: rows, next_cursor: "fixture-next" } });
  const client = await connect(t, { home: tempDir(t), base: mock.base, key: apiKey("d") });
  await recall(client);
  mock.state.identity.vaults[0].is_default = false;
  mock.state.identity.vaults.push({
    vault_id: VAULT_B, vault_name: "Acme", access: "owner", permissions: ["read"], is_default: true,
  });
  for (let page = 2; page <= 5; page++) {
    assert.deepEqual(rendered(await recall(client, { page })), rows.slice((page - 1) * 2, page * 2));
  }
  assert.equal(searches(mock).length, 1);
  const changed = { ...RECORD, id: "other", vault_id: VAULT_B };
  mock.state.replies.search.push({ status: 200, body: { success: true, results: [changed], next_cursor: null } });
  assert.deepEqual(rendered(await recall(client, { page: 6 })), [changed]);
  assert.equal(searches(mock).at(-1).headers["x-ragionex-vault-id"], undefined);
  assert.equal(mock.state.requests.some(request => request.url === "/v1/memory/identity"), false);
});

test("retained payloads are bounded and an evicted or uncacheable page uses its continuation", async (t) => {
  const mock = await startMock(t);
  const client = await connect(t, { home: tempDir(t), base: mock.base, key: apiKey("m") });
  const seeds = [records(2, 1, "a"), records(2, 1, "b"), records(2, 1, "c")];
  seeds[0][1].content = "a".repeat(2_100_000);
  seeds[1][1].content = "b".repeat(2_100_000);
  seeds[2][1].content = "c".repeat(4_100_000);
  const questions = ["Which build rules does acme-app use?", "Which test rules does acme-app use?", "Which release rules does acme-app use?"];
  for (let index = 0; index < 2; index++) {
    mock.state.replies.search.push({ status: 200, body: { success: true, results: seeds[index], next_cursor: null } });
    assert.deepEqual(rendered(await recall(client, { query: questions[index] })), seeds[index].slice(0, 1));
  }
  assert.deepEqual(rendered(await recall(client, { query: questions[1], page: 2 })), seeds[1].slice(1));
  assert.equal(searches(mock).length, 2);
  mock.state.replies.search.push({ status: 200, body: { success: true, results: seeds[0], next_cursor: null } });
  assert.deepEqual(rendered(await recall(client, { query: questions[0], page: 2 })), seeds[0].slice(1));
  assert.deepEqual(searches(mock).at(-1).body, { query: questions[0] });
  assert.equal(searches(mock).length, 3);
  mock.state.replies.search.push({ status: 200, body: { success: true, results: seeds[2], next_cursor: null } });
  await recall(client, { query: questions[2] });
  mock.state.replies.search.push({ status: 200, body: { success: true, results: seeds[2], next_cursor: null } });
  assert.deepEqual(rendered(await recall(client, { query: questions[2], page: 2 })), seeds[2].slice(1));
  assert.deepEqual(searches(mock).at(-1).body, { query: questions[2] });
  assert.equal(searches(mock).length, 5);
});

test("failed disk writes do not discard an already received remainder", async (t) => {
  const mock = await startMock(t);
  const home = tempDir(t);
  fs.writeFileSync(path.join(home, ".ragionex"), "Storage unavailable.");
  const rows = records(4);
  serveSearch(mock, rows);
  const client = await connect(t, { home, base: mock.base, key: apiKey("s") });
  assert.deepEqual(rendered(await recall(client)), rows.slice(0, 2));
  assert.deepEqual(rendered(await recall(client, { page: 2 })), rows.slice(2));
  assert.equal(searches(mock).length, 1);
});
