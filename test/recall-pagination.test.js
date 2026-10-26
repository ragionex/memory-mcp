import assert from "node:assert/strict";
import test from "node:test";
import { RULE_BODY } from "../build/init.js";
import { ACCOUNT_A, VAULT_A, VAULT_B, apiKey, connect, putProjectConfig, startMock, tempDir, text } from "./helpers.js";

const RECORD = {
  id: "mem_A",
  vault_id: VAULT_A,
  content: "The acme-app admin dashboard starts with pnpm dev.",
  created_at: "2026-09-26T08:30:00Z",
  updated_at: "2026-09-26T08:30:00Z",
  status: "ready",
  revision: 1,
  created_by: ACCOUNT_A,
  updated_by: ACCOUNT_A,
};
const QUESTION = "Which code editor does the user prefer?";
const NO_MORE_PAGES = "This search has no more pages. If the need is still unanswered, recall with a narrower question, or browse with ragionex_list_memories.";
const reminderBlocks = (result) => text(result).split("\u26a0\ufe0f REMINDER TO CALLER:").length - 1;
const recall = (client, args) => client.callTool({ name: "ragionex_recall_memory", arguments: args });
const searches = (mock) => mock.state.requests.filter(request => request.url === "/v1/memory/search");

test("recall pages by number and sends the stored continuation with the question and dates", async (t) => {
  const mock = await startMock(t);
  const home = tempDir(t);
  putProjectConfig(home, { vault_id: VAULT_A });
  const client = await connect(t, { home, base: mock.base, key: apiKey("p") });
  const continuation = ' page_+/=:"' + "x".repeat(180) + " ";
  const args = {
    query: "How is the acme-app admin dashboard started locally?",
    page: null,
    start_date: "2026-09-01",
    end_date: "2026-09-30",
  };
  const rows = Array.from({ length: 10 }, (_, index) => ({ ...RECORD, id: `mem_${index}` }));
  mock.state.replies.search.push({ status: 200, body: { success: true, results: rows, next_cursor: continuation } });
  const first = await recall(client, args);
  assert.ok(!first.isError, text(first));
  const rendered = text(first).split("\n\n").slice(0, 10).map(line => JSON.parse(line.replace(/^\[\d+\] /, "")));
  assert.deepEqual(rendered, rows);
  assert.match(text(first), /\n\n\u26a0\ufe0f REMINDER TO CALLER:\n- More records are on page 2\. If the task needs every matching record, do not answer yet: call ragionex_recall_memory with the same query, the same dates and page=2\. Keep paging until a page adds nothing relevant\. If you already have everything the task needs, stop\.\n- If the user said something newer than a record here, update that record\.\n- If two records say the same thing/);
  assert.equal(reminderBlocks(first), 1);
  assert.equal(text(first).includes("x".repeat(180)), false);
  assert.doesNotMatch(text(first), /cursor|\bcredits?\b/i);
  assert.match(text(first), /^(?:[\x00-\x7f]|\u26a0\ufe0f)*$/);
  assert.equal(Object.hasOwn(first, "structuredContent"), false);

  mock.state.replies.search.push({ status: 200, body: { success: true, results: [RECORD], next_cursor: null } });
  const last = await recall(client, { ...args, page: 2 });
  assert.ok(!last.isError, text(last));
  assert.match(text(last), /\n\nThis search has no more pages\.\n\n\u26a0\ufe0f REMINDER TO CALLER:\n- If the user said something newer than a record here, update that record\.\n- If the need is still unanswered, recall with a narrower question, or browse with ragionex_list_memories\.$/);
  assert.equal(reminderBlocks(last), 1);
  assert.doesNotMatch(text(last), /page=3|Stop paging|No records matched/);

  const beyond = await recall(client, { ...args, page: 3 });
  assert.ok(!beyond.isError, text(beyond));
  assert.equal(text(beyond), NO_MORE_PAGES);
  const { page, ...firstBody } = args;
  assert.deepEqual(searches(mock).map(request => request.body), [firstBody, { ...firstBody, cursor: continuation }]);
  for (const request of searches(mock)) {
    assert.equal(request.method, "POST");
    assert.equal(request.headers["x-ragionex-vault-id"], VAULT_A);
  }
  assert.equal(mock.state.requests.some(request => request.url === "/v1/memory/identity"), false);
});

test("a search's end and empty later pages are answered without treating the search as a miss", async (t) => {
  const mock = await startMock(t);
  const client = await connect(t, { home: tempDir(t), base: mock.base, key: apiKey("p") });
  const miss = await recall(client, { query: QUESTION });
  assert.ok(!miss.isError, text(miss));
  assert.match(text(miss), /No records matched in the selected Vault/);
  assert.match(text(miss), /If a date filter was set, retry once without filters/);
  assert.match(text(miss), /If the user stated a durable fact in this request, save it now/);
  assert.doesNotMatch(text(miss), /page=|Stop paging|no more pages/);
  const afterMiss = await recall(client, { query: QUESTION, page: 2 });
  assert.ok(!afterMiss.isError, text(afterMiss));
  assert.equal(text(afterMiss), NO_MORE_PAGES);
  assert.equal(searches(mock).length, 1);

  const other = "Which test framework does the user use?";
  mock.state.replies.search.push({ status: 200, body: { success: true, results: [RECORD], next_cursor: "opaque-2" } });
  assert.ok(!(await recall(client, { query: other })).isError);
  const empty = await recall(client, { query: other, page: 2 });
  assert.ok(!empty.isError, text(empty));
  assert.match(text(empty), /No more records were returned for this search/);
  assert.match(text(empty), /Use the records from earlier pages/);
  assert.doesNotMatch(text(empty), /No records matched|retry once without filters|save it now|Stop paging|page=/);
  assert.deepEqual(searches(mock).at(-1).body, { query: other, cursor: "opaque-2" });
  assert.equal(searches(mock).length, 3);
});

test("a page without a stored continuation makes no request and names the page to fetch first", async (t) => {
  const mock = await startMock(t);
  const client = await connect(t, { home: tempDir(t), base: mock.base, key: apiKey("p") });
  const dated = { query: QUESTION, start_date: "2026-09-01", end_date: "2026-09-30" };
  const early = await recall(client, { ...dated, page: 2 });
  assert.equal(early.isError, true);
  assert.equal(text(early), "Page 2 of this search is not available yet. This request was not carried out. Call ragionex_recall_memory for page 1 first, with the same query and dates. A different query or different dates start a new search at page 1.");
  assert.equal(mock.state.requests.length, 0);

  mock.state.replies.search.push({ status: 200, body: { success: true, results: [RECORD], next_cursor: "opaque-2" } });
  assert.ok(!(await recall(client, dated)).isError);
  for (const [args, first] of [
    [{ ...dated, page: 3 }, 2],
    [{ query: QUESTION, page: 2 }, 1],
    [{ ...dated, start_date: "2026-09-02", page: 2 }, 1],
    [{ ...dated, query: "Which code editor does the user like best?", page: 2 }, 1],
  ]) {
    const result = await recall(client, args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.match(text(result), new RegExp(`Call ragionex_recall_memory for page ${first} first`), JSON.stringify(args));
  }
  assert.equal(searches(mock).length, 1);

  const respaced = await recall(client, { ...dated, query: "  which CODE editor\tdoes the user   prefer? ", page: 2 });
  assert.ok(!respaced.isError, text(respaced));
  assert.deepEqual(searches(mock).at(-1).body, { ...dated, query: "which CODE editor\tdoes the user   prefer?", cursor: "opaque-2" });
  assert.equal(searches(mock).length, 2);
});

test("a later page keeps the project's Vault selection", async (t) => {
  const mock = await startMock(t);
  const home = tempDir(t);
  putProjectConfig(home, { vault_id: VAULT_A });
  const client = await connect(t, { home, base: mock.base, key: apiKey("p") });
  mock.state.replies.search.push({ status: 200, body: { success: true, results: [RECORD], next_cursor: "opaque-2" } });
  assert.ok(!(await recall(client, { query: QUESTION })).isError);
  putProjectConfig(home, { vault_id: VAULT_B });
  const switched = await recall(client, { query: QUESTION, page: 2 });
  assert.equal(switched.isError, true);
  assert.match(text(switched), /Call ragionex_recall_memory for page 1 first/);
  assert.equal(searches(mock).length, 1);
  putProjectConfig(home, { vault_id: VAULT_A });
  const resumed = await recall(client, { query: QUESTION, page: 2 });
  assert.ok(!resumed.isError, text(resumed));
  assert.equal(searches(mock).at(-1).headers["x-ragionex-vault-id"], VAULT_A);
  assert.deepEqual(searches(mock).at(-1).body, { query: QUESTION, cursor: "opaque-2" });
});

test("recall rejects a missing question, invalid fields and removed arguments locally", async (t) => {
  const mock = await startMock(t);
  const client = await connect(t, { home: tempDir(t), base: mock.base, key: apiKey("p") });
  for (const args of [
    {},
    { query: null },
    { page: 2 },
    { start_date: "2026-09-01" },
    { query: "abcd" },
    { query: "x".repeat(513) },
    { query: " ".repeat(12) },
    { query: "  abcd  " },
    { query: QUESTION, start_date: "not-a-date" },
    { query: QUESTION, start_date: "2026-09-30", end_date: "2026-09-01" },
    { query: QUESTION, page: 0 },
    { query: QUESTION, page: 1.5 },
    { query: QUESTION, page: "2" },
    { query: QUESTION, cursor: "opaque-2" },
    { queries: [QUESTION] },
    { query: QUESTION, results: 10 },
  ]) {
    const result = await recall(client, args);
    assert.equal(result.isError, true, JSON.stringify(args));
  }
  assert.equal(mock.state.requests.length, 0);
  for (const [query, sent] of [
    ["abcde", "abcde"],
    ["x".repeat(512), "x".repeat(512)],
    ["\t abcde  ", "abcde"],
    [` ${"x".repeat(512)}\n`, "x".repeat(512)],
  ]) {
    const result = await recall(client, { query, page: null, start_date: null, end_date: null });
    assert.ok(!result.isError, text(result));
    assert.deepEqual(mock.state.requests.at(-1).body, { query: sent });
  }
  assert.equal(mock.state.requests.length, 4);
});

test("recall rejects malformed response cursors and stores nothing from them", async (t) => {
  const mock = await startMock(t);
  const client = await connect(t, { home: tempDir(t), base: mock.base, key: apiKey("p") });
  for (const cursorFields of [{}, { next_cursor: "" }, { next_cursor: 7 }, { next_cursor: {} }]) {
    mock.state.replies.search.push({ status: 200, body: { success: true, results: [RECORD], ...cursorFields } });
    const before = mock.state.requests.length;
    const result = await recall(client, { query: QUESTION });
    assert.equal(result.isError, true);
    assert.match(text(result), /no valid next_cursor/);
    assert.doesNotMatch(text(result), /No records matched|No more records/);
    assert.equal(mock.state.requests.length, before + 1);
  }
  const later = await recall(client, { query: QUESTION, page: 2 });
  assert.match(text(later), /Call ragionex_recall_memory for page 1 first/);
  assert.equal(mock.state.requests.length, 4);
});

test("a rejected later page stays an error and keeps its stored continuation", async (t) => {
  const mock = await startMock(t);
  const client = await connect(t, { home: tempDir(t), base: mock.base, key: apiKey("p") });
  mock.state.replies.search.push({ status: 200, body: { success: true, results: [RECORD], next_cursor: "opaque-2" } });
  assert.ok(!(await recall(client, { query: QUESTION })).isError);
  for (const status of [400, 422, 500]) {
    mock.state.replies.search.push({ status, body: { success: false, code: "request_rejected", error: "Continuation rejected." } });
    const before = searches(mock).length;
    const result = await recall(client, { query: QUESTION, page: 2 });
    assert.equal(result.isError, true);
    assert.match(text(result), /Continuation rejected/);
    assert.doesNotMatch(text(result), /No records matched|No more records|no more pages/);
    assert.equal(searches(mock).length, before + 1);
    assert.deepEqual(searches(mock).at(-1).body, { query: QUESTION, cursor: "opaque-2" });
  }
});

test("recall guidance is split between call shaping and result handling", async (t) => {
  const mock = await startMock(t);
  const client = await connect(t, { home: tempDir(t), base: mock.base, key: apiKey("p") });
  const { tools } = await client.listTools();
  const tool = tools.find(item => item.name === "ragionex_recall_memory");
  const fields = tool.inputSchema.properties;
  const surfaces = [RULE_BODY, client.getInstructions(), tool.description, ...Object.values(fields).map(field => field.description ?? "")];
  const joined = surfaces.join("\n");
  assert.doesNotMatch(joined, /\bqueries\b|2-3|phrasings|different sides?|other angles?|narrower questions|per question|same queries|same.*dates.*Vault/i);
  assert.ok(surfaces.every(surface => /^[\x00-\x7f]*$/.test(surface)));
  for (const surface of [RULE_BODY, client.getInstructions(), tool.description, fields.query.description]) {
    assert.match(surface, /[Oo]ne complete (?:English )?question/);
    assert.match(surface, /whole conversation/);
    assert.match(surface, /[Ss]eparate recalls/);
  }
  const preCall = [
    RULE_BODY,
    client.getInstructions(),
    tool.description,
    ...Object.entries(fields).filter(([name]) => name !== "page").map(([, field]) => field.description ?? ""),
  ];
  for (const surface of preCall) {
    assert.doesNotMatch(surface, /\bpages?\b|\bpaging\b|\bcredits?\b|\bnext_cursor\b|\bcursor\b|\bcontinu(?:e|es|ed|ing|ation)\b/i);
  }
  assert.equal(fields.page.description, "Which results page to return for this query and dates. Omit or pass null for the first page.");
  assert.match(fields.query.description, /5-512 characters/);
  assert.equal(fields.query.type, "string");
  assert.equal(fields.query.minLength, 5);
  assert.equal(fields.query.maxLength, 512);
  assert.deepEqual(tool.inputSchema.required, ["query"]);
  for (const name of ["page", "start_date", "end_date"]) {
    assert.ok(fields[name].anyOf.some(option => option.type === "null"), name);
  }
  const pageSchema = fields.page.anyOf.find(option => option.type === "integer");
  assert.equal(pageSchema.minimum, 1);
  assert.equal(pageSchema.maximum, Number.MAX_SAFE_INTEGER);
  for (const name of ["cursor", "queries", "results"]) assert.equal(Object.hasOwn(fields, name), false, name);
  const descriptions = [tool.description, ...Object.values(fields).map(field => field.description ?? "")].join("\n");
  assert.ok(Buffer.byteLength(descriptions, "utf8") < 2048);
  assert.doesNotMatch([RULE_BODY, client.getInstructions(), JSON.stringify(tools)].join("\n"), /\bcredits?\b/i);

  const examples = RULE_BODY.split("\n").filter(value => value.startsWith("- ") && value.includes("recall(query=") && !value.startsWith("- Weak:"));
  for (const example of examples) {
    const calls = example.match(/recall\(query=/g) ?? [];
    assert.equal(calls.length, example.includes("I use Neovim, tabs and Jest") ? 3 : 1, example);
  }
  assert.ok(RULE_BODY.includes("how do I start the acme-app admin dashboard locally?"));
});
