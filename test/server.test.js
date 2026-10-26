import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { RULE_BODY } from "../build/init.js";
import {
  PACKAGE,
  ACCOUNT_A,
  ACCOUNT_B,
  VAULT_A,
  VAULT_B,
  apiKey,
  connect,
  pause,
  pendingFiles,
  putProjectConfig,
  queueDirectory,
  receiptKey,
  spoolFiles,
  startMock,
  tempDir,
  text,
  waitFor,
} from "./helpers.js";

// Non-ASCII content must survive byte for byte.
const CONTENT = `Quoted as written: ${String.fromCodePoint(0xe9, 0xe8, 0xea, 0x2014, 0x3b1, 0x3b2, 0x3b3, 0x2603)}`;
const DENIED = { status: 403, body: { success: false, error: "Missing permission: create", code: "permission_denied" } };

async function saveQueued(client, mock, content, reply = { status: 500, commit: true }) {
  mock.state.replies.write.push(reply);
  const result = await client.callTool({ name: "ragionex_save_memory", arguments: { content } });
  assert.match(text(result), /queued locally/);
}

test("the tool list states true effects and keeps its schemas", async (t) => {
  const mock = await startMock(t);
  const client = await connect(t, { home: tempDir(t), base: mock.base, key: apiKey("k") });
  assert.equal(client.getServerVersion().version, PACKAGE.version);
  assert.ok(client.getInstructions().length <= 2048);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 11);
  for (const tool of tools) {
    assert.equal(tool.annotations.openWorldHint, false, tool.name);
    assert.ok(Buffer.byteLength(tool.description, "utf8") < 1800, tool.name);
    const hasArguments = Object.keys(tool.inputSchema.properties).length > 0;
    assert.equal(tool.inputSchema.additionalProperties, hasArguments ? false : undefined, tool.name);
  }
  assert.deepEqual(
    tools.filter((tool) => tool.annotations.destructiveHint).map((tool) => tool.name).sort(),
    ["ragionex_delete_memory", "ragionex_restore_memory", "ragionex_update_memory"],
  );
  // Description text is calibrated prompt wording; only its position is pinned here.
  const schemas = JSON.parse(JSON.stringify(
    Object.fromEntries(tools.map((tool) => [tool.name, tool.inputSchema])),
    (key, value) => (key === "description" ? "described" : value),
  ));
  const draft7 = "http://json-schema.org/draft-07/schema#";
  const strict = (properties, required) => ({ $schema: draft7, type: "object", properties, ...(required && { required }), additionalProperties: false });
  const nullable = (schema, extra = {}) => ({ ...extra, anyOf: [schema, { type: "null" }], description: "described" });
  const id = { type: "string", minLength: 1, maxLength: 14, pattern: "^[A-Za-z0-9_]{1,14}$", description: "described" };
  const ids = { type: "array", items: { type: "string", minLength: 1, maxLength: 14, pattern: "^[A-Za-z0-9_]{1,14}$" }, minItems: 1, maxItems: 50, description: "described" };
  const content = { type: "string", minLength: 1, description: "described" };
  const revision = { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
  const date = nullable({ type: "string", maxLength: 40, pattern: /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/.source });
  assert.deepEqual(schemas, {
    ragionex_memory_connection: { $schema: draft7, type: "object", properties: {} },
    ragionex_save_memory: strict({ content }, ["content"]),
    ragionex_recall_memory: strict({
      query: { type: "string", minLength: 5, maxLength: 512, description: "described" },
      page: nullable({ type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
      start_date: date,
      end_date: date,
    }, ["query"]),
    ragionex_list_memories: strict({
      start_date: date,
      end_date: date,
      limit: { type: "integer", minimum: 1, maximum: 100, default: 50, description: "described" },
      cursor: nullable({ type: "string", minLength: 1, maxLength: 128 }),
    }),
    ragionex_view_memory: strict({ ids }, ["ids"]),
    ragionex_update_memory: strict({ id, expected_revision: { ...revision, description: "described" }, content }, ["id", "expected_revision", "content"]),
    ragionex_delete_memory: strict({ ids }, ["ids"]),
    ragionex_list_trash: strict({
      limit: nullable({ type: "integer", minimum: 1, maximum: 100 }, { default: 50 }),
      cursor: nullable({ type: "string", minLength: 1, maxLength: 128 }),
    }),
    ragionex_memory_versions: strict({
      id,
      revision: nullable(revision),
      limit: nullable({ type: "integer", minimum: 1, maximum: 100 }, { default: 25 }),
      cursor: nullable({ type: "string", minLength: 1, maxLength: 16 }),
    }, ["id"]),
    ragionex_restore_memory: strict({ id, expected_revision: { ...revision, description: "described" }, revision: nullable(revision) }, ["id", "expected_revision"]),
    ragionex_memory_status: strict({ id }, ["id"]),
  });
});

test("a confirmed save sends one idempotent request and keeps no local copy", async (t) => {
  const mock = await startMock(t);
  mock.state.identity.key.permissions.push("future_permission");
  const home = tempDir(t);
  const key = apiKey("k");
  const client = await connect(t, { home, base: mock.base, key });
  const connection = await client.callTool({ name: "ragionex_memory_connection", arguments: {} });
  assert.ok(!connection.isError, text(connection));
  const payload = { content: `The user prefers dark mode. ${CONTENT}` };
  const saved = await client.callTool({ name: "ragionex_save_memory", arguments: payload });
  assert.match(text(saved), /Saved record/);
  const [write] = mock.writes();
  assert.equal(mock.writes().length, 1);
  assert.match(write.headers["idempotency-key"], /^[0-9a-f-]{36}$/);
  assert.deepEqual(write.body, payload);
  const { content, ...acknowledgement } = mock.state.records.get("r1");
  assert.equal(content, payload.content);
  assert.deepEqual(JSON.parse(text(saved).replace(/^Saved record:\n/, "").split("\n\n\u26a0\ufe0f REMINDER TO CALLER:")[0]), acknowledgement);
  assert.deepEqual(spoolFiles(home), []);
  mock.state.replies.write.push({
    status: 200,
    body: { success: true, ...mock.state.records.get("r1"), id: "r42", content: "The user prefers tabs.", status: "archived" },
  });
  const unknownStatus = await client.callTool({ name: "ragionex_save_memory", arguments: { content: "The user prefers tabs." } });
  assert.match(text(unknownStatus), /Saved record/);
  assert.match(text(unknownStatus), /"status": "archived"/);
  assert.deepEqual(pendingFiles(home), []);
});

test("a save whose response was lost replays once with the same request ID", async (t) => {
  const mock = await startMock(t);
  const home = tempDir(t);
  const key = apiKey("a");
  const first = await connect(t, { home, base: mock.base, key });
  await first.callTool({ name: "ragionex_memory_connection", arguments: {} });
  await saveQueued(first, mock, "Replay me.");
  const [pending] = pendingFiles(home);
  assert.ok(pending);
  await first.close();
  await connect(t, { home, base: mock.base, key });
  assert.ok(await waitFor(() => pendingFiles(home).length === 0));
  const writes = mock.writes();
  assert.equal(writes.length, 2);
  assert.deepEqual(writes.map((write) => write.headers["idempotency-key"]), Array(2).fill(path.basename(pending).split(".")[0]));
  assert.deepEqual(writes[0].body, writes[1].body);
  assert.equal(mock.state.receipts.size, 1);
});

test("offline default saves stage before HTTP and never inherit a later project target", async (t) => {
  const mock = await startMock(t);
  mock.state.identity.vaults.push({ ...mock.state.identity.vaults[0], vault_id: VAULT_B, vault_name: "Acme", is_default: false });
  const home = tempDir(t);
  const key = apiKey("a");
  const client = await connect(t, { home, base: mock.base, key });
  let stagedAtSend;
  mock.state.onWrite = () => {
    stagedAtSend = JSON.parse(fs.readFileSync(pendingFiles(home)[0], "utf-8"));
    mock.state.onWrite = null;
  };
  mock.state.replies.write.push({ disconnect: true });
  const payload = { content: "Keep the complete fact while offline." };
  const queued = await client.callTool({ name: "ragionex_save_memory", arguments: payload });
  assert.ok(!queued.isError, text(queued));
  assert.match(text(queued), /queued locally/);
  const [file] = pendingFiles(home);
  const bytes = fs.readFileSync(file, "utf-8");
  assert.equal(bytes.includes(key), false);
  const envelope = JSON.parse(bytes);
  assert.deepEqual(stagedAtSend, envelope);
  assert.equal(envelope.vault_id, null);
  assert.deepEqual(envelope.payload, payload);
  assert.equal(envelope.checksum, createHash("sha256").update(JSON.stringify([
    envelope.operation_id, envelope.connection_id, null, envelope.created_at, envelope.payload,
  ])).digest("hex"));
  assert.deepEqual(mock.state.requests.map(request => request.url), ["/v1/memory/write"]);
  assert.equal(mock.writes()[0].headers["x-ragionex-vault-id"], undefined);

  mock.state.replies.identity.push({ status: 503 });
  const report = JSON.parse(text(await client.callTool({ name: "ragionex_memory_connection", arguments: {} })));
  assert.equal(report.queue.pending[0].vault_id, null);
  assert.equal(report.queue.pending[0].vault_source, "account_default");

  putProjectConfig(home, { vault_id: VAULT_A, api_key: apiKey("b") });
  await client.callTool({ name: "ragionex_memory_connection", arguments: {} });
  assert.equal(mock.writes().length, 1);
  assert.equal(fs.readFileSync(file, "utf-8"), bytes);
  mock.state.identity.vaults[0].is_default = false;
  mock.state.identity.vaults[1].is_default = true;
  putProjectConfig(home, { vault_id: VAULT_A, api_key: key });
  await client.callTool({ name: "ragionex_memory_connection", arguments: {} });
  assert.ok(await waitFor(() => pendingFiles(home).length === 0));
  assert.equal(mock.writes().length, 2);
  assert.ok(mock.writes().every(request => request.headers["x-ragionex-vault-id"] === undefined));
  assert.ok(mock.writes().every(request => request.headers["idempotency-key"] === envelope.operation_id));
  assert.deepEqual(mock.writes().map(request => request.body), [payload, payload]);
  assert.equal([...mock.state.records.values()][0].vault_id, VAULT_B);
  assert.equal(mock.state.charges, 1);
});

test("a local staging failure sends no HTTP and is not reported as queued", async (t) => {
  const mock = await startMock(t);
  const home = tempDir(t);
  fs.writeFileSync(path.join(home, ".ragionex"), "Storage unavailable.");
  const client = await connect(t, { home, base: mock.base, key: apiKey("a") });
  const result = await client.callTool({ name: "ragionex_save_memory", arguments: { content: "Do not claim this is safe." } });
  assert.equal(result.isError, true);
  assert.doesNotMatch(text(result), /queued locally|Saved record:/);
  assert.deepEqual(mock.state.requests, []);
});

test("envelopes that fail validation require recovery while valid saves replay unchanged", async (t) => {
  const mock = await startMock(t);
  const home = tempDir(t);
  const key = apiKey("u");
  const first = await connect(t, { home, base: mock.base, key });
  await first.callTool({ name: "ragionex_memory_connection", arguments: {} });
  await saveQueued(first, mock, "Valid queued content.");
  const [validPath] = pendingFiles(home);
  assert.ok(validPath);
  await first.close();
  const template = JSON.parse(fs.readFileSync(validPath, "utf-8"));
  const folder = path.dirname(validPath);
  const unsupported = [];
  for (const state of ["pending", "blocked-invalid_request"]) {
    const envelope = {
      ...template,
      operation_id: randomUUID(),
      payload: { content: `Recovery-only content ${unsupported.length}.`, future_field: "unexpected" },
    };
    envelope.checksum = createHash("sha256").update(JSON.stringify([
      envelope.operation_id, envelope.connection_id, envelope.vault_id, envelope.created_at, envelope.payload,
    ])).digest("hex");
    const file = path.join(folder, `${envelope.operation_id}.${state}.json`);
    const bytes = `${JSON.stringify(envelope)}\n`;
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    unsupported.push({ file, bytes, content: envelope.payload.content });
  }

  const second = await connect(t, { home, base: mock.base, key });
  assert.ok(await waitFor(() => !fs.existsSync(validPath)));
  const report = await second.callTool({ name: "ragionex_memory_connection", arguments: {} });
  assert.ok(!report.isError, text(report));
  const { queue } = JSON.parse(text(report));
  assert.deepEqual(queue.pending, []);
  assert.deepEqual(queue.blocked, []);
  assert.deepEqual(queue.recovery_required.map((item) => item.path).sort(), unsupported.map((item) => item.file).sort());
  for (const item of queue.recovery_required) assert.match(item.reason, /explicit recovery required/);
  for (const item of unsupported) {
    assert.equal(fs.readFileSync(item.file, "utf-8"), item.bytes);
    assert.equal(text(report).includes(item.content), false);
  }
  assert.deepEqual(fs.readdirSync(folder).sort(), unsupported.map((item) => path.basename(item.file)).sort());
  assert.equal(mock.writes().length, 2);
  for (const request of mock.writes()) {
    assert.equal(request.headers["idempotency-key"], template.operation_id);
    assert.deepEqual(request.body, template.payload);
  }
  assert.equal(mock.state.records.size, 1);
  assert.equal(mock.state.receipts.size, 1);
  await second.close();

  const third = await connect(t, { home, base: mock.base, key });
  const restarted = JSON.parse(text(await third.callTool({ name: "ragionex_memory_connection", arguments: {} })));
  assert.deepEqual(restarted.queue.recovery_required.map((item) => item.path).sort(), unsupported.map((item) => item.file).sort());
  assert.equal(mock.writes().length, 2);
  for (const item of unsupported) assert.equal(fs.readFileSync(item.file, "utf-8"), item.bytes);
});

test("a receipt conflict preserves the original operation for recovery", async (t) => {
  const mock = await startMock(t);
  const home = tempDir(t);
  const key = apiKey("v");
  const first = await connect(t, { home, base: mock.base, key });
  await first.callTool({ name: "ragionex_memory_connection", arguments: {} });
  await saveQueued(first, mock, "Keep this operation unchanged.");
  const [pending] = pendingFiles(home);
  assert.ok(pending);
  await first.close();
  const bytes = fs.readFileSync(pending, "utf-8");
  const envelope = JSON.parse(bytes);
  const receipt = mock.state.receipts.get(receiptKey(envelope.operation_id));
  receipt.fingerprint = JSON.stringify({ content: "A different accepted payload." });

  const second = await connect(t, { home, base: mock.base, key });
  const blocked = path.join(path.dirname(pending), `${envelope.operation_id}.blocked-idempotency_mismatch.json`);
  assert.ok(await waitFor(() => fs.existsSync(blocked)));
  assert.equal(fs.existsSync(pending), false);
  assert.equal(fs.readFileSync(blocked, "utf-8"), bytes);
  const report = JSON.parse(text(await second.callTool({ name: "ragionex_memory_connection", arguments: {} })));
  assert.equal(report.queue.blocked.length, 1);
  assert.equal(report.queue.blocked[0].operation_id, envelope.operation_id);
  assert.equal(report.queue.blocked[0].reason, "idempotency_mismatch");
  assert.equal(mock.writes().length, 2);
  for (const request of mock.writes()) {
    assert.equal(request.headers["idempotency-key"], envelope.operation_id);
    assert.deepEqual(request.body, envelope.payload);
  }
  assert.equal(mock.state.receipts.size, 1);
  assert.equal(mock.state.records.size, 1);
});

test("a replayed save whose record was deleted is blocked and never resent", async (t) => {
  const mock = await startMock(t);
  const home = tempDir(t);
  const key = apiKey("b");
  const first = await connect(t, { home, base: mock.base, key });
  await first.callTool({ name: "ragionex_memory_connection", arguments: {} });
  await saveQueued(first, mock, "Deleted later.");
  await first.close();
  for (const receipt of mock.state.receipts.values()) mock.state.deleted.add(receipt.id);
  const second = await connect(t, { home, base: mock.base, key });
  assert.ok(await waitFor(() => spoolFiles(home).some((file) => file.endsWith(".blocked-record_deleted.json"))));
  await second.close();
  const writes = mock.writes().length;
  const third = await connect(t, { home, base: mock.base, key });
  const status = await third.callTool({ name: "ragionex_memory_connection", arguments: {} });
  await pause(500);
  assert.equal(mock.writes().length, writes);
  assert.match(text(status), /record_deleted/);
  assert.doesNotMatch(text(status), /Deleted later\./);
});

test("a default change replays pending saves into their original Vault", async (t) => {
  const mock = await startMock(t);
  const home = tempDir(t);
  putProjectConfig(home, { vault_id: VAULT_A });
  const key = apiKey("c");
  const first = await connect(t, { home, base: mock.base, key });
  await first.callTool({ name: "ragionex_memory_connection", arguments: {} });
  await saveQueued(first, mock, "Bound to the first Vault.", { status: 502 });
  await first.close();
  fs.unlinkSync(path.join(home, "RAGIONEX_MEMORY.jsonc"));
  mock.state.identity.vaults[0].is_default = false;
  mock.state.identity.vaults.push({ ...mock.state.identity.vaults[0], vault_id: VAULT_B, vault_name: "Acme", is_default: true });
  const second = await connect(t, { home, base: mock.base, key });
  assert.ok(await waitFor(() => pendingFiles(home).length === 0));
  assert.ok(mock.writes().every(write => write.headers["x-ragionex-vault-id"] === VAULT_A));
  const status = await second.callTool({ name: "ragionex_memory_connection", arguments: {} });
  assert.ok(!status.isError, text(status));
  assert.equal(JSON.parse(text(status)).target_vault_id, VAULT_B);
});

test("other keys never replay a save, and only folders holding saves count", async (t) => {
  const mock = await startMock(t);
  const home = tempDir(t);
  const legacy = path.join(home, ".ragionex", "pending-memories.jsonl");
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, '{"content":"old unattributed"}\n');
  const first = await connect(t, { home, base: mock.base, key: apiKey("d") });
  await first.callTool({ name: "ragionex_memory_connection", arguments: {} });
  await saveQueued(first, mock, "Key D only.");
  await first.close();
  const idle = await connect(t, { home, base: mock.base, key: apiKey("f") });
  await idle.callTool({ name: "ragionex_memory_connection", arguments: {} });
  await idle.close();
  mock.state.identity.key.key_id = 8;
  const writes = mock.writes().length;
  const client = await connect(t, { home, base: mock.base, key: apiKey("e") });
  const status = await client.callTool({ name: "ragionex_memory_connection", arguments: {} });
  await pause(500);
  assert.equal(mock.writes().length, writes);
  assert.match(text(status), /pending-memories\.jsonl/);
  assert.match(text(status), /"other_connection_directories": 1/);
  assert.equal(fs.readFileSync(legacy, "utf-8"), '{"content":"old unattributed"}\n');
});

// A read-only folder keeps the local copy; root bypasses the mode, and Windows ignores it for removal.
test("a rejected save that cannot be removed stays pending without blocking later saves", { skip: process.getuid?.() === 0 || process.platform === "win32" }, async (t) => {
  const mock = await startMock(t);
  const home = tempDir(t);
  const client = await connect(t, { home, base: mock.base, key: apiKey("h") });
  await client.callTool({ name: "ragionex_memory_connection", arguments: {} });
  const folder = queueDirectory(home, mock.base, apiKey("h"));
  mock.state.onWrite = () => {
    fs.chmodSync(folder, 0o500);
    mock.state.onWrite = null;
  };
  mock.state.replies.write.push(DENIED);
  const denied = await client.callTool({ name: "ragionex_save_memory", arguments: { content: "Denied." } });
  fs.chmodSync(folder, 0o700);
  assert.equal(denied.isError, true);
  assert.match(text(denied), /could not be removed/);
  assert.equal(pendingFiles(home).length, 1);
  const saved = await client.callTool({ name: "ragionex_save_memory", arguments: { content: "Allowed later." } });
  assert.match(text(saved), /Saved record/);
});

test("fresh saves during a server-requested delay stage without another send", async (t) => {
  const mock = await startMock(t);
  const home = tempDir(t);
  const key = apiKey("i");
  const client = await connect(t, { home, base: mock.base, key });
  mock.state.replies.write.push({ status: 429, headers: { "Retry-After": "3600" } });
  const before = Date.now();
  for (let i = 0; i < 6; i++) {
    const result = await client.callTool({ name: "ragionex_save_memory", arguments: { content: `Waiting fact ${i}.` } });
    assert.ok(!result.isError, text(result));
    assert.match(text(result), /Save not confirmed yet/);
    assert.match(text(result), /queued locally/);
  }
  assert.equal(mock.writes().length, 1);
  assert.equal(pendingFiles(home).length, 6);
  const report = JSON.parse(text(await client.callTool({ name: "ragionex_memory_connection", arguments: {} })));
  assert.equal(report.queue.pending.length, 6);
  assert.ok(Date.parse(report.queue.next_retry_at) >= before + 3_600_000);
  assert.equal(mock.writes().length, 1);
  await client.close();
  await connect(t, { home, base: mock.base, key });
  assert.ok(await waitFor(() => pendingFiles(home).length === 0));
  assert.equal(mock.writes().length, 7);
  assert.equal(mock.state.receipts.size, 6);
  assert.equal(mock.state.charges, 6);
});

test("replay skips past a payload-specific failure but honours a requested delay", async (t) => {
  const mock = await startMock(t);
  const home = tempDir(t);
  const key = apiKey("j");
  const first = await connect(t, { home, base: mock.base, key });
  await first.callTool({ name: "ragionex_memory_connection", arguments: {} });
  for (const content of ["First queued fact.", "Second queued fact.", "Third queued fact."]) {
    await saveQueued(first, mock, content, { status: 502 });
  }
  await first.close();

  mock.state.replies.write.push({ status: 503, headers: { "Retry-After": "30" } });
  let writes = mock.writes().length;
  const second = await connect(t, { home, base: mock.base, key });
  assert.ok(await waitFor(() => mock.writes().length > writes));
  await pause(500);
  assert.equal(mock.writes().length, writes + 1);
  await second.close();

  mock.state.replies.write.push({ status: 500 });
  writes = mock.writes().length;
  await connect(t, { home, base: mock.base, key });
  assert.ok(await waitFor(() => pendingFiles(home).length === 1));
  assert.equal(mock.writes().length, writes + 3);
  assert.equal(mock.state.receipts.size, 2);
});

test("only unsynced saves count toward the local queue limit", async (t) => {
  const mock = await startMock(t);
  const home = tempDir(t);
  const client = await connect(t, { home, base: mock.base, key: apiKey("g") });
  await client.callTool({ name: "ragionex_memory_connection", arguments: {} });
  const folder = queueDirectory(home, mock.base, apiKey("g"));
  fs.mkdirSync(folder, { recursive: true });
  for (let i = 0; i < 100; i++) fs.writeFileSync(path.join(folder, `${randomUUID()}.blocked-invalid_request.json`), "{}");
  const saved = await client.callTool({ name: "ragionex_save_memory", arguments: { content: "Blocked files do not count." } });
  assert.match(text(saved), /Saved record/);
  for (let i = 0; i < 100; i++) fs.writeFileSync(path.join(folder, `${randomUUID()}.pending.json`), "{}");
  const writes = mock.writes().length;
  const refused = await client.callTool({ name: "ragionex_save_memory", arguments: { content: "Over capacity." } });
  assert.equal(refused.isError, true);
  assert.match(text(refused), /storage is full/);
  assert.equal(mock.writes().length, writes);
});

test("a plain HTTP API address is accepted only for this machine", async (t) => {
  const client = await connect(t, { home: tempDir(t), base: "http://api.example.test", key: apiKey("m") });
  const result = await client.callTool({ name: "ragionex_recall_memory", arguments: { query: "What editor does the user prefer?" } });
  assert.equal(result.isError, true);
  assert.match(text(result), /must use HTTPS/);
});

test("the runtime refresh follows a relocated agent home and keeps symlinks", async (t) => {
  const root = tempDir(t);
  const home = path.join(root, "home");
  const codexHome = path.join(root, "work-codex");
  const dotfiles = path.join(root, "dotfiles");
  for (const dir of [home, codexHome, dotfiles]) fs.mkdirSync(dir);
  const target = path.join(dotfiles, "AGENTS.md");
  fs.writeFileSync(target, "# Team rules\n\n<!-- ragionex-memory-mcp:priority-rule:begin -->\nold body\n<!-- ragionex-memory-mcp:priority-rule:end -->\n");
  fs.symlinkSync(target, path.join(codexHome, "AGENTS.md"));
  await connect(t, { home, env: { CODEX_HOME: codexHome }, name: "codex-mcp-client" });
  assert.ok(await waitFor(() => fs.readFileSync(target, "utf-8").includes(RULE_BODY)));
  assert.equal(fs.lstatSync(path.join(codexHome, "AGENTS.md")).isSymbolicLink(), true);
  assert.ok(fs.readFileSync(target, "utf-8").startsWith("# Team rules\n"));
  assert.equal(fs.existsSync(path.join(home, ".codex")), false);
});

test("an incomplete accepted-save reply keeps its operation ID through recovery", async (t) => {
  const mock = await startMock(t);
  const home = tempDir(t);
  const key = apiKey("w");
  const first = await connect(t, { home, base: mock.base, key });
  await first.callTool({ name: "ragionex_memory_connection", arguments: {} });
  mock.state.replies.write.push({
    status: 200,
    commit: true,
    body: { success: true, id: "r1", status: "processing" },
  });
  const queued = await first.callTool({ name: "ragionex_save_memory", arguments: { content: "Preserve this accepted operation." } });
  assert.match(text(queued), /queued locally/);
  const [file] = pendingFiles(home);
  assert.ok(file);
  const envelope = JSON.parse(fs.readFileSync(file, "utf-8"));
  assert.deepEqual(envelope.payload, { content: "Preserve this accepted operation." });
  await first.close();
  await connect(t, { home, base: mock.base, key });
  assert.ok(await waitFor(() => pendingFiles(home).length === 0));
  assert.equal(mock.writes().length, 2);
  assert.ok(mock.writes().every((request) => request.headers["idempotency-key"] === envelope.operation_id));
  assert.deepEqual(mock.writes()[0].body, mock.writes()[1].body);
  assert.equal(mock.state.records.size, 1);
  assert.equal(mock.state.receipts.size, 1);
});

for (const [code, reason] of [
  ["quota_exceeded", "Plan limit reached"],
  ["payg_unavailable", "Pay-as-you-go is currently unavailable"],
]) {
  test(`a live ${code} save remains pending and replays with its original request ID`, async (t) => {
    const mock = await startMock(t);
    const home = tempDir(t);
    const client = await connect(t, { home, base: mock.base, key: apiKey("z") });
    await client.callTool({ name: "ragionex_memory_connection", arguments: {} });
    mock.state.replies.write.push({
      status: 402,
      body: { success: false, error: "Write not accepted", code },
    });
    const payload = { content: "Keep this fact until the service can accept it." };
    const before = Date.now();
    const held = await client.callTool({ name: "ragionex_save_memory", arguments: payload });
    assert.ok(!held.isError, text(held));
    assert.ok(text(held).includes(reason));
    assert.match(text(held), /queued locally/);
    assert.match(text(held), /not yet searchable/);
    assert.match(text(held), /do not repeat the save/i);
    assert.doesNotMatch(text(held), /Save not confirmed|Saved record:/);
    if (code === "quota_exceeded") {
      assert.match(text(held), /sent automatically after the quota resets/);
      assert.match(text(held), /Tell the user the save is waiting for the quota reset/);
    } else {
      assert.match(text(held), /sent automatically when it is available/);
      assert.doesNotMatch(text(held), /Plan limit reached|quota resets/);
    }

    const files = pendingFiles(home);
    assert.equal(files.length, 1);
    const [file] = files;
    const bytes = fs.readFileSync(file, "utf-8");
    const envelope = JSON.parse(bytes);
    assert.deepEqual(envelope.payload, payload);
    assert.ok(!text(held).includes(envelope.operation_id));
    assert.equal(mock.writes().length, 1);
    assert.equal(mock.writes()[0].headers["idempotency-key"], envelope.operation_id);
    assert.deepEqual(mock.writes()[0].body, payload);
    assert.equal(mock.state.records.size, 0);
    assert.equal(mock.state.receipts.size, 0);

    mock.state.replies.identity.push({ status: 503 });
    const status = await client.callTool({ name: "ragionex_memory_connection", arguments: {} });
    assert.equal(status.isError, true);
    const { queue } = JSON.parse(text(status));
    assert.equal(queue.last_failure, "plan_limit");
    assert.equal(queue.pending.length, 1);
    assert.equal(queue.pending[0].operation_id, envelope.operation_id);
    assert.deepEqual(queue.blocked, []);
    assert.deepEqual(queue.recovery_required, []);
    assert.ok(Date.parse(queue.next_retry_at) >= before + 1_800_000, queue.next_retry_at);
    await pause(100);
    assert.equal(mock.writes().length, 1);
    assert.equal(fs.readFileSync(file, "utf-8"), bytes);

    const resumed = await client.callTool({ name: "ragionex_memory_connection", arguments: {} });
    assert.ok(!resumed.isError, text(resumed));
    assert.ok(await waitFor(() => pendingFiles(home).length === 0));
    const writes = mock.writes();
    assert.equal(writes.length, 2);
    assert.deepEqual(writes.map((request) => request.headers["idempotency-key"]), [envelope.operation_id, envelope.operation_id]);
    assert.deepEqual(writes.map((request) => request.body), [payload, payload]);
    assert.equal(mock.state.records.size, 1);
    assert.equal(mock.state.receipts.size, 1);
    assert.deepEqual(spoolFiles(home), []);
    const acknowledged = await client.callTool({ name: "ragionex_memory_connection", arguments: {} });
    assert.ok(!acknowledged.isError, text(acknowledged));
    const finalQueue = JSON.parse(text(acknowledged)).queue;
    assert.deepEqual(finalQueue.pending, []);
    assert.equal(finalQueue.last_failure, null);
    await pause(100);
    assert.equal(mock.writes().length, 2);
  });
}

test("credential changes preserve another partition and retry delays survive switching back", async (t) => {
  const mock = await startMock(t);
  const home = tempDir(t);
  const keyA = apiKey("a");
  const keyB = apiKey("b");
  putProjectConfig(home, { vault_id: VAULT_A, api_key: keyA });
  const client = await connect(t, { home, base: mock.base, key: keyA });
  await saveQueued(client, mock, "Key A's pending save.", { status: 429, headers: { "Retry-After": "3600" } });
  const [file] = pendingFiles(home);
  const bytes = fs.readFileSync(file, "utf-8");
  putProjectConfig(home, { vault_id: VAULT_A, api_key: keyB });
  const report = JSON.parse(text(await client.callTool({ name: "ragionex_memory_connection", arguments: {} })));
  assert.deepEqual(report.queue.pending, []);
  assert.equal(report.queue.other_connection_directories, 1);
  const saved = await client.callTool({ name: "ragionex_save_memory", arguments: { content: "Key B's new save." } });
  assert.ok(!saved.isError, text(saved));
  assert.equal(mock.writes().at(-1).headers["x-api-key"], keyB);
  assert.equal(fs.readFileSync(file, "utf-8"), bytes);
  putProjectConfig(home, { vault_id: VAULT_A, api_key: keyA });
  const restored = JSON.parse(text(await client.callTool({ name: "ragionex_memory_connection", arguments: {} })));
  assert.equal(restored.queue.pending.length, 1);
  assert.ok(Date.parse(restored.queue.next_retry_at) > Date.now() + 3_000_000);
  await pause(100);
  assert.equal(mock.writes().filter(write => write.headers["x-api-key"] === keyA).length, 1);
  assert.equal(fs.readFileSync(file, "utf-8"), bytes);
});

test("concurrent saves keep their file credential target and acknowledgements separate", async (t) => {
  const mock = await startMock(t);
  mock.state.identity.vaults.push({ ...mock.state.identity.vaults[0], vault_id: VAULT_B, vault_name: "Acme", is_default: false });
  const keyA = apiKey("a");
  const keyB = apiKey("b");
  mock.state.identities.set(keyB, { ...mock.state.identity, account_id: ACCOUNT_B, key: { ...mock.state.identity.key, key_id: 8 } });
  const home = tempDir(t);
  putProjectConfig(home, { vault_id: VAULT_A, api_key: keyA });
  const client = await connect(t, { home, base: mock.base, key: keyA });
  mock.state.replies.write.push({
    status: 200, commit: true, delayMs: 600,
    body: {
      success: true, id: "r1", vault_id: VAULT_A, revision: 1, status: "processing",
      created_at: "2026-09-26T08:30:00Z", updated_at: "2026-09-26T08:30:00Z",
      created_by: ACCOUNT_A, updated_by: ACCOUNT_A,
    },
  });
  const first = client.callTool({ name: "ragionex_save_memory", arguments: { content: "The first invocation." } });
  assert.ok(await waitFor(() => mock.writes().length === 1));
  putProjectConfig(home, { vault_id: VAULT_B, api_key: keyB });
  const second = await client.callTool({ name: "ragionex_save_memory", arguments: { content: "The second invocation." } });
  const delayed = await first;
  for (const result of [delayed, second]) assert.ok(!result.isError, text(result));
  const metadata = result => JSON.parse(text(result).replace(/^Saved record:\n/, "").split("\n\n\u26a0\ufe0f REMINDER TO CALLER:")[0]);
  assert.equal(metadata(delayed).vault_id, VAULT_A);
  assert.equal(metadata(delayed).created_by, ACCOUNT_A);
  assert.equal(metadata(second).vault_id, VAULT_B);
  assert.equal(metadata(second).created_by, ACCOUNT_B);
  assert.deepEqual(mock.writes().map(write => [write.headers["x-api-key"], write.headers["x-ragionex-vault-id"]]), [[keyA, VAULT_A], [keyB, VAULT_B]]);
  assert.deepEqual(pendingFiles(home), []);
  assert.equal(mock.state.receipts.size, 2);
});

test("an acknowledgement for another Vault remains pending and replays to its original target", async (t) => {
  const mock = await startMock(t);
  const home = tempDir(t);
  putProjectConfig(home, { vault_id: VAULT_A });
  const key = apiKey("a");
  const first = await connect(t, { home, base: mock.base, key });
  const reply = {
    status: 200, commit: true,
    body: {
      success: true, id: "r1", vault_id: VAULT_B, revision: 1, status: "processing",
      created_at: "2026-09-26T08:30:00Z", updated_at: "2026-09-26T08:30:00Z",
      created_by: ACCOUNT_A, updated_by: ACCOUNT_A,
    },
  };
  await saveQueued(first, mock, "Retain the real destination.", reply);
  const envelope = JSON.parse(fs.readFileSync(pendingFiles(home)[0], "utf-8"));
  assert.equal(envelope.vault_id, VAULT_A);
  await first.close();
  await connect(t, { home, base: mock.base, key });
  assert.ok(await waitFor(() => pendingFiles(home).length === 0));
  assert.ok(mock.writes().every(write => write.headers["x-ragionex-vault-id"] === VAULT_A));
  assert.ok(mock.writes().every(write => write.headers["idempotency-key"] === envelope.operation_id));
  assert.equal(mock.state.records.size, 1);
});

test("one replay 401 blocks the credential partition without changing bytes or destinations", async (t) => {
  const mock = await startMock(t);
  const home = tempDir(t);
  const key = apiKey("a");
  const first = await connect(t, { home, base: mock.base, key });
  await saveQueued(first, mock, "A default recovery entry.", { status: 500 });
  putProjectConfig(home, { vault_id: VAULT_A });
  await saveQueued(first, mock, "An explicit recovery entry.", { status: 500 });
  const saved = pendingFiles(home).map(file => ({
    file, bytes: fs.readFileSync(file, "utf-8"), envelope: JSON.parse(fs.readFileSync(file, "utf-8")),
  }));
  await first.close();
  mock.state.identities.set(key, null);
  const before = mock.writes().length;
  const second = await connect(t, { home, base: mock.base, key });
  const blocked = saved.map(item => path.join(path.dirname(item.file), `${item.envelope.operation_id}.blocked-authentication_required.json`));
  assert.ok(await waitFor(() => blocked.every(file => fs.existsSync(file))));
  assert.equal(mock.writes().length, before + 1);
  assert.deepEqual(pendingFiles(home), []);
  for (let i = 0; i < saved.length; i++) assert.equal(fs.readFileSync(blocked[i], "utf-8"), saved[i].bytes);
  const report = JSON.parse(text(await second.callTool({ name: "ragionex_memory_connection", arguments: {} })));
  assert.equal(report.queue.blocked.length, 2);
  assert.ok(report.queue.blocked.every(item => item.reason === "authentication_required"));
  assert.equal(report.queue.blocked.find(item => item.vault_id === null).vault_source, "account_default");
  assert.equal(mock.state.records.size, 0);
  mock.state.identities.delete(key);
  await second.callTool({ name: "ragionex_memory_connection", arguments: {} });
  assert.equal(mock.writes().length, before + 1);
  await second.close();
  putProjectConfig(home, { vault_id: VAULT_A, api_key: apiKey("b") });
  const other = await connect(t, { home, base: mock.base, key: apiKey("b") });
  await other.callTool({ name: "ragionex_memory_connection", arguments: {} });
  assert.equal(mock.writes().length, before + 1);
  for (let i = 0; i < saved.length; i++) assert.equal(fs.readFileSync(blocked[i], "utf-8"), saved[i].bytes);
});

for (const [status, code] of [[403, "no_access"], [404, "vault_not_found"]]) {
  test(`a default replay refused with ${code} stays pending until access is restored`, async (t) => {
    const mock = await startMock(t);
    const home = tempDir(t);
    const key = apiKey("a");
    const first = await connect(t, { home, base: mock.base, key });
    await saveQueued(first, mock, "Keep a recoverable access refusal pending.", { status: 500 });
    const [file] = pendingFiles(home);
    const bytes = fs.readFileSync(file, "utf-8");
    await first.close();
    mock.state.replies.write.push({ status, body: { success: false, error: "Access unavailable.", code } });
    const second = await connect(t, { home, base: mock.base, key });
    assert.ok(await waitFor(() => mock.writes().length === 2));
    assert.equal(fs.readFileSync(file, "utf-8"), bytes);
    await second.callTool({ name: "ragionex_memory_connection", arguments: {} });
    assert.ok(await waitFor(() => pendingFiles(home).length === 0));
    assert.equal(mock.writes().length, 3);
    assert.ok(mock.writes().every(request => request.headers["x-ragionex-vault-id"] === undefined));
    assert.ok(mock.writes().every(request => request.headers["idempotency-key"] === JSON.parse(bytes).operation_id));
  });
}

test("an unavailable queued Vault remains pending and never writes to the current default", async (t) => {
  const mock = await startMock(t);
  const home = tempDir(t);
  putProjectConfig(home, { vault_id: VAULT_A });
  const key = apiKey("a");
  const first = await connect(t, { home, base: mock.base, key });
  await saveQueued(first, mock, "Never redirect this pending save.", { status: 500 });
  const [file] = pendingFiles(home);
  const bytes = fs.readFileSync(file, "utf-8");
  await first.close();
  mock.state.identity.vaults = [{ ...mock.state.identity.vaults[0], vault_id: VAULT_B, vault_name: "Acme" }];
  await connect(t, { home, base: mock.base, key });
  assert.ok(await waitFor(() => mock.writes().length === 2));
  assert.ok(mock.writes().every(write => write.headers["x-ragionex-vault-id"] === VAULT_A));
  assert.equal(fs.readFileSync(file, "utf-8"), bytes);
  assert.equal(mock.state.records.size, 0);
});

test("a denied stored Vault pauses its entries while other stored targets proceed", async (t) => {
  const mock = await startMock(t);
  mock.state.identity.vaults.push({ ...mock.state.identity.vaults[0], vault_id: VAULT_B, vault_name: "Acme", is_default: false });
  const home = tempDir(t);
  putProjectConfig(home, { vault_id: VAULT_A });
  const client = await connect(t, { home, base: mock.base, key: apiKey("a") });
  await saveQueued(client, mock, "A is denied later.", { status: 500 });
  putProjectConfig(home, { vault_id: VAULT_B });
  await saveQueued(client, mock, "B remains writable.", { status: 500 });
  mock.state.identity.vaults[0].permissions = ["read"];
  await client.callTool({ name: "ragionex_memory_connection", arguments: {} });
  assert.ok(await waitFor(() => pendingFiles(home).length === 1));
  const envelope = JSON.parse(fs.readFileSync(pendingFiles(home)[0], "utf-8"));
  assert.equal(envelope.vault_id, VAULT_A);
  assert.equal(mock.writes().filter(write => write.headers["x-ragionex-vault-id"] === VAULT_B).length, 2);
  assert.equal(mock.state.records.size, 1);
});

test("configuration errors pause replay without latching a storage or authorization failure", async (t) => {
  const mock = await startMock(t);
  const home = tempDir(t);
  const key = apiKey("a");
  putProjectConfig(home, { vault_id: VAULT_A });
  const first = await connect(t, { home, base: mock.base, key });
  await saveQueued(first, mock, "Resume after config repair.", { status: 500 });
  await first.close();
  putProjectConfig(home, "{");
  const client = await connect(t, { home, base: mock.base, key });
  assert.equal((await client.callTool({ name: "ragionex_memory_connection", arguments: {} })).isError, true);
  assert.equal(pendingFiles(home).length, 1);
  putProjectConfig(home, { vault_id: VAULT_A });
  const result = await client.callTool({ name: "ragionex_memory_connection", arguments: {} });
  assert.ok(!result.isError, text(result));
  assert.equal(JSON.parse(text(result)).queue.storage_error, null);
  assert.ok(await waitFor(() => pendingFiles(home).length === 0));
});

test("an interrupted staging file is preserved for explicit recovery and never sent", async (t) => {
  const mock = await startMock(t);
  const home = tempDir(t);
  const key = apiKey("a");
  const folder = queueDirectory(home, mock.base, key);
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${randomUUID()}.tmp`);
  const bytes = '{"operation_id":';
  fs.writeFileSync(file, bytes);
  const client = await connect(t, { home, base: mock.base, key });
  const report = JSON.parse(text(await client.callTool({ name: "ragionex_memory_connection", arguments: {} })));
  assert.deepEqual(report.queue.pending, []);
  assert.deepEqual(report.queue.recovery_required.map(item => item.path), [file]);
  assert.match(report.queue.recovery_required[0].reason, /explicit recovery required/);
  assert.equal(fs.readFileSync(file, "utf-8"), bytes);
  assert.equal(mock.writes().length, 0);
});
