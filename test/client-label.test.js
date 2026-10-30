import assert from "node:assert/strict";
import test from "node:test";
import { PACKAGE, apiKey, connect, machine, pendingFiles, startMock, tempDir, text, waitFor } from "./helpers.js";

const LABEL = `ragionex-memory-mcp/${PACKAGE.version}`;
const sent = (requests) => requests.map((request) => [request.method, request.url.split("?")[0], request.headers["user-agent"]]);

test("tool requests send the client label", async (t) => {
  const mock = await startMock(t);
  const client = await connect(t, { home: tempDir(t), base: mock.base, key: apiKey("k") });
  await client.callTool({ name: "ragionex_memory_connection", arguments: {} });
  await client.callTool({ name: "ragionex_save_memory", arguments: { content: "The user prefers dark mode." } });
  await client.callTool({ name: "ragionex_recall_memory", arguments: { query: "Which editor theme does the user prefer?" } });
  await client.callTool({ name: "ragionex_list_memories", arguments: {} });
  assert.deepEqual(sent(mock.state.requests), [
    ["GET", "/v1/memory/identity", LABEL],
    ["POST", "/v1/memory/write", LABEL],
    ["POST", "/v1/memory/search", LABEL],
    ["GET", "/v1/memory/list", LABEL],
  ]);
});

test("a queued save replayed by a later connector sends the client label", async (t) => {
  const mock = await startMock(t);
  const home = tempDir(t);
  const key = apiKey("a");
  const first = await connect(t, { home, base: mock.base, key });
  await first.callTool({ name: "ragionex_memory_connection", arguments: {} });
  mock.state.replies.write.push({ status: 500, commit: true });
  const queued = await first.callTool({ name: "ragionex_save_memory", arguments: { content: "Replay me." } });
  assert.match(text(queued), /queued locally/);
  await first.close();
  await connect(t, { home, base: mock.base, key });
  assert.ok(await waitFor(() => pendingFiles(home).length === 0));
  assert.deepEqual(mock.writes().map((write) => write.headers["user-agent"]), [LABEL, LABEL]);
});

test("the installer's key check sends the client label", async (t) => {
  const mock = await startMock(t);
  const box = machine(t);
  const result = await box.run(["install", "--agent", "claude-code", "--api-key", apiKey("a")], { RAGIONEX_API_BASE: mock.base });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(sent(mock.state.requests), [["GET", "/v1/memory/identity", LABEL]]);
});
