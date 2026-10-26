import assert from "node:assert/strict";
import test from "node:test";
import { apiKey, connect, pendingFiles, spoolFiles, startMock, tempDir, text } from "./helpers.js";

test("writes expose only content and updates require the revision read from view", async (t) => {
  const mock = await startMock(t);
  const home = tempDir(t);
  const client = await connect(t, { home, base: mock.base, key: apiKey("s") });
  const { tools } = await client.listTools();
  const saveSchema = tools.find((tool) => tool.name === "ragionex_save_memory").inputSchema;
  const updateSchema = tools.find((tool) => tool.name === "ragionex_update_memory").inputSchema;
  assert.deepEqual(Object.keys(saveSchema.properties), ["content"]);
  assert.deepEqual(saveSchema.required, ["content"]);
  assert.deepEqual(Object.keys(updateSchema.properties).sort(), ["content", "expected_revision", "id"]);
  assert.deepEqual([...updateSchema.required].sort(), ["content", "expected_revision", "id"]);
  assert.equal(saveSchema.additionalProperties, false);
  assert.equal(updateSchema.additionalProperties, false);

  for (const name of ["ragionex_save_memory", "ragionex_update_memory"]) {
    const valid = name === "ragionex_save_memory"
      ? { content: "A durable fact." }
      : { id: "mem_A", expected_revision: 1, content: "A revised fact." };
    for (const field of ["extra_field_a", "extra_field_b", "extra_field_c", "project", "created_by"]) {
      for (const value of ["unexpected", null]) {
        const result = await client.callTool({ name, arguments: { ...valid, [field]: value } });
        assert.equal(result.isError, true, `${name}: ${field}`);
        assert.match(text(result), /Unrecognized key/);
      }
    }
  }
  for (const args of [
    { id: "mem_A", expected_revision: 1 },
    { id: "mem_A", expected_revision: 1, content: null },
    { id: "mem_A", expected_revision: 1, content: "" },
    { id: "mem_A", content: "A revised fact." },
    { id: "mem_A", expected_revision: 0, content: "A revised fact." },
    { id: "mem_A", expected_revision: 1.5, content: "A revised fact." },
    { id: "mem_A", expected_revision: "1", content: "A revised fact." },
  ]) {
    const result = await client.callTool({ name: "ragionex_update_memory", arguments: args });
    assert.equal(result.isError, true);
  }
  assert.equal(mock.state.requests.length, 0);
  assert.deepEqual(pendingFiles(home), []);

  const saved = await client.callTool({
    name: "ragionex_save_memory", arguments: { content: "The user prefers a dark theme." },
  });
  assert.ok(!saved.isError, text(saved));
  const record = JSON.parse(text(saved).replace(/^Saved record:\n/, "").split("\n\n\u26a0\ufe0f REMINDER TO CALLER:")[0]);
  const viewed = await client.callTool({ name: "ragionex_view_memory", arguments: { ids: [record.id] } });
  assert.ok(!viewed.isError, text(viewed));
  const read = JSON.parse(text(viewed));
  const changed = {
    ...read,
    content: "The user prefers a light theme.",
    updated_at: "2026-09-26T08:31:00Z",
    revision: 2,
  };
  const { content, ...acknowledgement } = changed;
  mock.state.replies.update.push({ status: 200, body: { success: true, ...acknowledgement } });
  const args = { id: read.id, expected_revision: read.revision, content: changed.content };
  const updated = await client.callTool({ name: "ragionex_update_memory", arguments: args });
  assert.ok(!updated.isError, text(updated));
  assert.deepEqual(JSON.parse(text(updated).replace(/^Updated record:\n/, "").split("\n\n\u26a0\ufe0f REMINDER TO CALLER:")[0]), acknowledgement);
  assert.equal(mock.state.requests.filter(request => request.url === "/v1/memory/view").length, 1);
  assert.deepEqual(mock.state.requests.find((request) => request.method === "PUT").body, args);

  const conflict = await client.callTool({ name: "ragionex_update_memory", arguments: args });
  assert.equal(conflict.isError, true);
  assert.match(text(conflict), /revision_conflict/);
  assert.match(text(conflict), /Read the record again/);
  assert.equal(mock.state.requests.filter((request) => request.method === "PUT").length, 2);
  assert.deepEqual(pendingFiles(home), []);
});

test("content has no fixed connector maximum and server rejection remains an error", async (t) => {
  const mock = await startMock(t);
  const home = tempDir(t);
  const client = await connect(t, { home, base: mock.base, key: apiKey("s") });
  const { tools } = await client.listTools();
  for (const name of ["ragionex_save_memory", "ragionex_update_memory"]) {
    const schema = tools.find((tool) => tool.name === name).inputSchema.properties.content;
    assert.equal(schema.minLength, 1);
    assert.equal(Object.hasOwn(schema, "maxLength"), false);
  }
  const content = "x".repeat(50001);
  const saved = await client.callTool({ name: "ragionex_save_memory", arguments: { content } });
  assert.ok(!saved.isError, text(saved));
  assert.match(text(saved), /^Saved record:\n/);
  const savedRecord = JSON.parse(text(saved).replace(/^Saved record:\n/, "").split("\n\n\u26a0\ufe0f REMINDER TO CALLER:")[0]);
  assert.deepEqual(mock.writes()[0].body, { content });
  assert.deepEqual(pendingFiles(home), []);

  const stored = mock.state.records.get(savedRecord.id);
  assert.equal(stored.content, content);
  const changes = { id: savedRecord.id, expected_revision: stored.revision, content: "y".repeat(50001) };
  mock.state.replies.update.push({
    status: 200,
    body: { success: true, ...stored, content: changes.content, revision: 2, updated_at: "2026-09-26T08:31:00Z" },
  });
  const updated = await client.callTool({ name: "ragionex_update_memory", arguments: changes });
  assert.ok(!updated.isError, text(updated));
  const updates = mock.state.requests.filter((item) => item.method === "PUT");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].url, "/v1/memory/update");
  assert.deepEqual(updates[0].body, changes);

  mock.state.replies.write.push({ status: 400, body: { success: false, error: "Content is too long", code: "content_too_long" } });
  const rejected = await client.callTool({ name: "ragionex_save_memory", arguments: { content } });
  assert.equal(rejected.isError, true);
  assert.match(text(rejected), /content_too_long/);
  assert.doesNotMatch(text(rejected), /queued locally/);
  assert.equal(mock.writes().length, 2);
  assert.deepEqual(mock.writes()[1].body, { content });
  assert.deepEqual(spoolFiles(home), []);
});
