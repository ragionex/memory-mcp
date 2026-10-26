import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { ACCOUNT_A, VAULT_A, apiKey, connect, queueDirectory, startMock, tempDir, text } from "./helpers.js";

const QUESTION = "Which deployment target does acme-app use?";
const CONTENT = "acme-app deploys to its staging cluster every Friday.";
const RECORD = {
  id: "mem_A",
  vault_id: VAULT_A,
  content: CONTENT,
  created_at: "2026-09-26T08:30:00Z",
  updated_at: "2026-09-26T08:30:00Z",
  status: "ready",
  revision: 1,
  created_by: ACCOUNT_A,
  updated_by: ACCOUNT_A,
};
const DAY_MS = 86_400_000;
const recall = (client, args) => client.callTool({ name: "ragionex_recall_memory", arguments: args });
const searches = (mock) => mock.state.requests.filter(request => request.url === "/v1/memory/search");
const recallRoot = (home) => path.join(home, ".ragionex", "recall-pages");
// Recall folders are named exactly like the pending-save folder of the same key and API address.
const recallFolder = (home, base, key) => path.join(recallRoot(home), path.basename(queueDirectory(home, base, key)));
const filesUnder = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? filesUnder(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);

test("a later page survives a restart, and stored files hold no question, record text or key", async (t) => {
  const mock = await startMock(t);
  const home = tempDir(t);
  const key = apiKey("s");
  const continuation = ' mem_1.mem_2 "quoted" ' + "x".repeat(300);
  const dated = { query: QUESTION, start_date: "2026-09-01", end_date: "2026-09-30" };
  const first = await connect(t, { home, base: mock.base, key });
  mock.state.replies.search.push({ status: 200, body: { success: true, results: [RECORD], next_cursor: continuation } });
  assert.ok(!(await recall(first, dated)).isError);
  await first.close();
  const folder = recallFolder(home, mock.base, key);
  assert.deepEqual(fs.readdirSync(recallRoot(home)), [path.basename(folder)]);
  const names = fs.readdirSync(folder);
  assert.equal(names.length, 1);
  assert.match(names[0], /^[a-f0-9]{64}\.json$/);
  const file = path.join(folder, names[0]);
  const stored = JSON.parse(fs.readFileSync(file, "utf-8"));
  assert.deepEqual(Object.keys(stored).sort(), ["pages", "saved_at"]);
  assert.deepEqual(stored.pages, { 2: continuation });
  assert.ok(Math.abs(Date.now() - Date.parse(stored.saved_at)) < 60_000);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(folder).mode & 0o777, 0o700);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }

  const second = await connect(t, { home, base: mock.base, key });
  const resumed = await recall(second, { ...dated, query: " which DEPLOYMENT target  does acme-app use? ", page: 2 });
  assert.ok(!resumed.isError, text(resumed));
  assert.deepEqual(searches(mock).at(-1).body, { ...dated, query: "which DEPLOYMENT target  does acme-app use?", cursor: continuation });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf-8")).pages, { 2: continuation, 3: null });

  const otherKey = await connect(t, { home, base: mock.base, key: apiKey("t") });
  const unrelated = await recall(otherKey, { ...dated, page: 2 });
  assert.equal(unrelated.isError, true);
  assert.match(text(unrelated), /Call ragionex_recall_memory for page 1 first/);
  assert.equal(searches(mock).length, 2);

  for (const local of filesUnder(path.join(home, ".ragionex"))) {
    const content = fs.readFileSync(local, "utf-8").toLowerCase();
    for (const secret of [QUESTION, "deployment target", CONTENT, "every friday", key]) {
      assert.equal(content.includes(secret.toLowerCase()), false, `${local} holds ${secret}`);
    }
  }
});

test("a write deletes our files older than 30 days in every connection folder and removes emptied folders", async (t) => {
  const mock = await startMock(t);
  const home = tempDir(t);
  const key = apiKey("e");
  const first = await connect(t, { home, base: mock.base, key });
  mock.state.replies.search.push({ status: 200, body: { success: true, results: [RECORD], next_cursor: "opaque-2" } });
  assert.ok(!(await recall(first, { query: QUESTION })).isError);
  await first.close();
  const folder = recallFolder(home, mock.base, key);
  const [name] = fs.readdirSync(folder);
  const expired = path.join(folder, name);
  const old = new Date(Date.now() - 31 * DAY_MS);
  fs.writeFileSync(expired, JSON.stringify({ saved_at: old.toISOString(), pages: { 2: "opaque-2" } }));
  const uuid = `${"c".repeat(8)}-${"c".repeat(4)}-${"c".repeat(4)}-${"c".repeat(4)}-${"c".repeat(12)}`;
  const staleOther = path.join(folder, `${"a".repeat(64)}.json`);
  const staleTemporary = path.join(folder, `${"b".repeat(64)}.${uuid}.tmp`);
  const recent = path.join(folder, `${"d".repeat(64)}.json`);
  const foreign = path.join(folder, "notes.txt");
  const abandoned = path.join(recallRoot(home), "f".repeat(64));
  const abandonedStale = path.join(abandoned, `${"9".repeat(64)}.json`);
  const foreignFolder = path.join(recallRoot(home), "keep");
  fs.mkdirSync(abandoned);
  fs.mkdirSync(foreignFolder);
  for (const file of [staleOther, staleTemporary, recent, foreign, abandonedStale]) fs.writeFileSync(file, "{}");
  for (const file of [expired, staleOther, staleTemporary, foreign, abandonedStale]) fs.utimesSync(file, old, old);
  const kept = new Date(Date.now() - 29 * DAY_MS);
  fs.utimesSync(recent, kept, kept);

  const second = await connect(t, { home, base: mock.base, key });
  const later = await recall(second, { query: QUESTION, page: 2 });
  assert.equal(later.isError, true);
  assert.match(text(later), /Call ragionex_recall_memory for page 1 first/);
  assert.equal(searches(mock).length, 1);

  assert.ok(!(await recall(second, { query: "Which database does pixelforge use?" })).isError);
  for (const file of [expired, staleOther, staleTemporary, abandonedStale, abandoned]) assert.equal(fs.existsSync(file), false, file);
  for (const file of [recent, foreign, foreignFolder]) assert.ok(fs.existsSync(file), file);
  assert.equal(fs.readdirSync(folder).length, 3);
  assert.deepEqual(fs.readdirSync(recallRoot(home)).sort(), [path.basename(folder), "keep"].sort());
});

test("concurrent connectors keep questions apart, page on with their own continuation and leave whole files", async (t) => {
  const mock = await startMock(t);
  const home = tempDir(t);
  const key = apiKey("c");
  let logs = "";
  const onStderr = (chunk) => { logs += chunk; };
  const left = await connect(t, { home, base: mock.base, key, onStderr });
  const right = await connect(t, { home, base: mock.base, key, onStderr });
  const questions = Array.from({ length: 12 }, (_, index) => `Which build tool does service number ${index} use?`);
  const shared = "Which package manager does acme-app use?";
  const calls = [...questions.map((query, index) => [index % 2 ? right : left, query]), [left, shared], [right, shared]];
  for (const index of calls.keys()) {
    mock.state.replies.search.push({ status: 200, body: { success: true, results: [RECORD], next_cursor: `next-${index}` } });
  }
  const results = await Promise.all(calls.map(([client, query]) => recall(client, { query })));
  for (const result of results) assert.ok(!result.isError, text(result));
  // The mock answers in arrival order, so a request's position names the continuation it received.
  const issued = new Map();
  for (const [index, request] of searches(mock).entries()) {
    issued.set(request.body.query, [...(issued.get(request.body.query) ?? []), `next-${index}`]);
  }
  const folder = recallFolder(home, mock.base, key);
  assert.deepEqual(fs.readdirSync(recallRoot(home)), [path.basename(folder)]);
  const names = fs.readdirSync(folder);
  assert.equal(names.length, questions.length + 1, `${names.join(",")}\n${logs}`);
  assert.ok(names.every(name => /^[a-f0-9]{64}\.json$/.test(name)), names.join(","));

  const restarted = await connect(t, { home, base: mock.base, key });
  for (const query of questions) {
    assert.ok(!(await recall(restarted, { query, page: 2 })).isError, query);
    assert.deepEqual(searches(mock).at(-1).body, { query, cursor: issued.get(query)[0] });
  }
  assert.ok(!(await recall(restarted, { query: shared, page: 2 })).isError);
  assert.ok(issued.get(shared).includes(searches(mock).at(-1).body.cursor));

  const own = await Promise.all([left, right].map(client => recall(client, { query: shared, page: 2 })));
  for (const result of own) assert.ok(!result.isError, text(result));
  assert.deepEqual(searches(mock).slice(-2).map(request => request.body.cursor).sort(), [...issued.get(shared)].sort());
});

test("a page is returned when its continuation cannot be stored, and the same connector keeps paging", async (t) => {
  const mock = await startMock(t);
  const home = tempDir(t);
  fs.writeFileSync(path.join(home, ".ragionex"), "Storage unavailable.");
  const client = await connect(t, { home, base: mock.base, key: apiKey("f") });
  mock.state.replies.search.push({ status: 200, body: { success: true, results: [RECORD], next_cursor: "opaque-2" } });
  const first = await recall(client, { query: QUESTION });
  assert.ok(!first.isError, text(first));
  assert.match(text(first), /page=2\./);
  const second = await recall(client, { query: QUESTION, page: 2 });
  assert.ok(!second.isError, text(second));
  assert.deepEqual(searches(mock).at(-1).body, { query: QUESTION, cursor: "opaque-2" });
});
