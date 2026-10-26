import assert from "node:assert/strict";
import test from "node:test";
import { ACCOUNT_A, VAULT_A, VAULT_B, apiKey, connect, pendingFiles, putProjectConfig, startMock, tempDir, text } from "./helpers.js";

const RECORD = {
  id: "mem_A", vault_id: VAULT_A, content: "A retained fixture.", created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-02T00:00:00Z", status: "ready", revision: 1, created_by: ACCOUNT_A, updated_by: ACCOUNT_A,
};
const VERSION = {
  ...RECORD, operation: "create", restored_from_revision: null,
  expires_at: "2026-10-02T00:00:00Z", is_current: false,
};

test("trash and version reads page within the connected Vault and strip unknown fields", async (t) => {
  const mock = await startMock(t);
  const client = await connect(t, { home: tempDir(t), base: mock.base, key: apiKey("k") });
  mock.state.replies.trash.push({ status: 200, body: {
    success: true, memories: [{ ...RECORD, status: "trashed", revision: 2,
      deleted_at: "2026-09-02T00:00:00Z", expires_at: "2026-10-02T00:00:00Z", extra_fixture: "hidden" }], next_cursor: "cursor-a",
  } });
  const trash = await client.callTool({ name: "ragionex_list_trash", arguments: { limit: 1, cursor: null } });
  assert.ok(!trash.isError, text(trash));
  assert.equal(JSON.parse(text(trash)).next_cursor, "cursor-a");
  assert.doesNotMatch(text(trash), /extra_fixture/);
  mock.state.replies.versions.push({ status: 200, body: {
    success: true, current_revision: 3, versions: [{ ...VERSION, extra_fixture: "hidden" }], next_cursor: "1",
  } });
  const versions = await client.callTool({ name: "ragionex_memory_versions", arguments: { id: RECORD.id, revision: null, cursor: "3", limit: 1 } });
  assert.ok(!versions.isError, text(versions));
  assert.equal(JSON.parse(text(versions)).current_revision, 3);
  assert.doesNotMatch(text(versions), /extra_fixture/);
  mock.state.replies.version.push({ status: 200, body: {
    success: true, current_revision: 3, version: { ...VERSION, content: "x".repeat(70000) },
  } });
  const detail = await client.callTool({ name: "ragionex_memory_versions", arguments: { id: RECORD.id, revision: 1, cursor: null } });
  assert.equal(JSON.parse(text(detail)).version.content.length, 70000);
  const requests = mock.state.requests.filter((request) => /\/(trash|versions)\b/.test(request.url));
  assert.deepEqual(requests.map((request) => [request.method, request.url]), [
    ["GET", "/v1/memory/trash?limit=1"],
    ["GET", "/v1/memory/versions/mem_A?limit=1&cursor=3"],
    ["GET", "/v1/memory/versions/mem_A/1"],
  ]);
  assert.ok(requests.every(request => request.headers["x-ragionex-vault-id"] === undefined));
  assert.equal(mock.state.requests.some(request => request.url === "/v1/memory/identity"), false);
});

test("restore uses the expected revision once and is never queued offline", async (t) => {
  const mock = await startMock(t);
  const home = tempDir(t);
  const client = await connect(t, { home, base: mock.base, key: apiKey("k") });
  const { content, ...acknowledgement } = RECORD;
  mock.state.replies.restore.push({ status: 200, body: { success: true, ...acknowledgement, revision: 4, status: "processing", extra_fixture: "hidden" } });
  const restored = await client.callTool({ name: "ragionex_restore_memory", arguments: { id: RECORD.id, expected_revision: 3, revision: 1 } });
  assert.ok(!restored.isError, text(restored));
  assert.equal(JSON.parse(text(restored).replace(/^Restored record:\n/, "")).revision, 4);
  assert.doesNotMatch(text(restored), /extra_fixture/);
  assert.equal(Object.hasOwn(JSON.parse(text(restored).replace(/^Restored record:\n/, "")), "content"), false);
  for (const [status, code] of [[409, "revision_conflict"], [500, "internal_error"], [403, "permission_denied"], [410, "record_expired"]]) {
    mock.state.replies.restore.push({ status, body: { success: false, error: "Fixture refusal", code } });
    const result = await client.callTool({ name: "ragionex_restore_memory", arguments: { id: RECORD.id, expected_revision: 4, revision: null } });
    assert.equal(result.isError, true);
  }
  const requests = mock.state.requests.filter((request) => request.url === "/v1/memory/restore");
  assert.equal(requests.length, 5);
  assert.deepEqual(requests[0].body, { id: RECORD.id, expected_revision: 3, revision: 1 });
  assert.deepEqual(requests[1].body, { id: RECORD.id, expected_revision: 4 });
  assert.equal(pendingFiles(home).length, 0);
  assert.equal(mock.state.requests.filter((request) => request.url === "/v1/memory/write").length, 0);
});

test("new tools reject extra or unsafe arguments and malformed responses", async (t) => {
  const mock = await startMock(t);
  const client = await connect(t, { home: tempDir(t), base: mock.base, key: apiKey("k") });
  const invalid = [
    ["ragionex_restore_memory", { id: RECORD.id, expected_revision: 0 }],
    ["ragionex_restore_memory", { id: RECORD.id, expected_revision: Number.MAX_SAFE_INTEGER + 1 }],
    ["ragionex_restore_memory", { id: RECORD.id, expected_revision: 1, permanent: true }],
    ["ragionex_memory_versions", { id: RECORD.id, revision: 1, cursor: "2" }],
    ["ragionex_list_trash", { limit: 101 }],
  ];
  // Count only tool requests.
  const toolRequests = () => mock.state.requests.filter((request) => request.url !== "/v1/memory/identity").length;
  const before = toolRequests();
  for (const [name, args] of invalid) {
    assert.equal((await client.callTool({ name, arguments: args })).isError, true);
  }
  assert.equal(toolRequests(), before);
  mock.state.replies.versions.push({ status: 200, body: { success: true, current_revision: 2, versions: [RECORD], next_cursor: null } });
  assert.equal((await client.callTool({ name: "ragionex_memory_versions", arguments: { id: RECORD.id } })).isError, true);
  mock.state.replies.restore.push({ status: 200, body: { success: true, ...RECORD, status: "processing", revision: 2 } });
  const restored = await client.callTool({ name: "ragionex_restore_memory", arguments: { id: RECORD.id, expected_revision: 1 } });
  assert.ok(!restored.isError, text(restored));
  assert.equal(JSON.parse(text(restored).replace(/^Restored record:\n/, "")).status, "processing");
  assert.doesNotMatch(text(restored), /\u26a0\ufe0f REMINDER TO CALLER:/);
  const { tools } = await client.listTools();
  assert.equal(tools.some((tool) => /purge|empty_trash|permanent/.test(tool.name)), false);
});

test("history and restore follow file changes without an identity request or content readback", async (t) => {
  const mock = await startMock(t);
  mock.state.identity.vaults.push({ ...mock.state.identity.vaults[0], vault_id: VAULT_B, vault_name: "Acme", is_default: false });
  const home = tempDir(t);
  const client = await connect(t, { home, base: mock.base, key: apiKey("k") });
  for (const target of [VAULT_A, VAULT_B]) {
    if (target === VAULT_B) putProjectConfig(home, { vault_id: target });
    const record = { ...RECORD, vault_id: target };
    const version = { ...VERSION, vault_id: target };
    const { content, ...acknowledgement } = record;
    mock.state.replies.trash.push({ status: 200, body: {
      success: true, memories: [{ ...record, status: "trashed", deleted_at: "2026-09-02T00:00:00Z", expires_at: "2026-10-02T00:00:00Z" }], next_cursor: null,
    } });
    mock.state.replies.versions.push({ status: 200, body: { success: true, current_revision: 2, versions: [version], next_cursor: null } });
    mock.state.replies.version.push({ status: 200, body: { success: true, current_revision: 2, version } });
    mock.state.replies.restore.push({ status: 200, body: { success: true, ...acknowledgement, revision: 3, status: "processing" } });
    for (const [name, args] of [
      ["ragionex_list_trash", {}],
      ["ragionex_memory_versions", { id: record.id }],
      ["ragionex_memory_versions", { id: record.id, revision: 1 }],
      ["ragionex_restore_memory", { id: record.id, expected_revision: 2, revision: 1 }],
    ]) {
      const result = await client.callTool({ name, arguments: args });
      assert.ok(!result.isError, `${name}: ${text(result)}`);
      assert.equal(mock.state.requests.at(-1).headers["x-ragionex-vault-id"], target === VAULT_A ? undefined : target);
    }
  }
  assert.equal(mock.state.requests.length, 8);
  assert.equal(mock.state.requests.some(request => request.url === "/v1/memory/identity" || request.url === "/v1/memory/view"), false);
});
