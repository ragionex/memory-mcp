import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { RULE_BODY } from "../build/init.js";
import { VAULT_A, VAULT_B, apiKey, connect, pendingFiles, projectFile, putProjectConfig, startMock, tempDir, text, waitFor } from "./helpers.js";

const KEY_A = apiKey("a");
const KEY_B = apiKey("b");

function addSecondVault(mock) {
  mock.state.identity.vaults.push({
    vault_id: VAULT_B, vault_name: "Acme", access: "shared",
    permissions: ["read", "create", "update", "delete"], is_default: false,
  });
}

test("one client follows file creation target key repair removal and live default changes", async (t) => {
  const mock = await startMock(t);
  addSecondVault(mock);
  const home = tempDir(t);
  const client = await connect(t, { home, base: mock.base, key: KEY_A, name: "codex-mcp-client" });
  const list = () => client.callTool({ name: "ragionex_list_memories", arguments: {} });
  const lastList = () => mock.state.requests.filter(request => request.url.startsWith("/v1/memory/list?")).at(-1);
  assert.ok(!(await list()).isError);
  assert.equal(lastList().headers["x-ragionex-vault-id"], undefined);
  putProjectConfig(home, { vault_id: VAULT_A });
  assert.ok(!(await list()).isError);
  assert.equal(lastList().headers["x-ragionex-vault-id"], VAULT_A);
  putProjectConfig(home, { vault_id: VAULT_B });
  assert.ok(!(await list()).isError);
  assert.equal(lastList().headers["x-ragionex-vault-id"], VAULT_B);
  mock.state.identities.set(KEY_B, { ...mock.state.identity, key: { key_id: 8, label: "Read key", permissions: ["read"] } });
  putProjectConfig(home, { vault_id: VAULT_B, api_key: KEY_B });
  const denied = await client.callTool({ name: "ragionex_save_memory", arguments: { content: "A denied save." } });
  assert.equal(denied.isError, true);
  assert.match(text(denied), /no_access/);
  assert.deepEqual(pendingFiles(home), []);
  assert.ok(!(await list()).isError);
  assert.equal(lastList().headers["x-api-key"], KEY_B);
  putProjectConfig(home, { vault_id: VAULT_B, api_key: "bad key" });
  let before = mock.state.requests.length;
  assert.equal((await list()).isError, true);
  assert.equal(mock.state.requests.length, before);
  const malformedSave = await client.callTool({ name: "ragionex_save_memory", arguments: { content: "Reject before staging." } });
  assert.equal(malformedSave.isError, true);
  assert.equal(mock.state.requests.length, before);
  assert.deepEqual(pendingFiles(home), []);
  const rejectedKey = apiKey("r");
  mock.state.identities.set(rejectedKey, null);
  putProjectConfig(home, { vault_id: VAULT_B, api_key: rejectedKey });
  const rejected = await list();
  assert.equal(rejected.isError, true);
  assert.match(text(rejected), /selected_key_rejected/);
  assert.equal(mock.state.requests.at(-1).headers["x-api-key"], rejectedKey);
  assert.equal(mock.state.requests.length, before + 1);
  putProjectConfig(home, { vault_id: VAULT_B, api_key: KEY_B });
  assert.ok(!(await list()).isError);
  putProjectConfig(home, { vault_id: VAULT_B });
  assert.ok(!(await list()).isError);
  assert.equal(lastList().headers["x-api-key"], KEY_A);
  putProjectConfig(home, "{");
  before = mock.state.requests.length;
  assert.equal((await list()).isError, true);
  assert.equal(mock.state.requests.length, before);
  putProjectConfig(home, { vault_id: VAULT_A });
  assert.ok(!(await list()).isError);
  fs.unlinkSync(projectFile(home));
  mock.state.identity.vaults[0].is_default = false;
  mock.state.identity.vaults[1].is_default = true;
  assert.ok(!(await list()).isError);
  assert.equal(lastList().headers["x-ragionex-vault-id"], undefined);
  const saved = await client.callTool({ name: "ragionex_save_memory", arguments: { content: "Follow the current default." } });
  assert.ok(!saved.isError, text(saved));
  assert.equal(mock.writes().at(-1).headers["x-ragionex-vault-id"], undefined);
  mock.state.identity.vaults[0].is_default = true;
  mock.state.identity.vaults[1].is_default = false;
  const recalled = await client.callTool({ name: "ragionex_recall_memory", arguments: { query: "What is the current preference?" } });
  assert.ok(!recalled.isError, text(recalled));
  const search = mock.state.requests.findLast(request => request.url === "/v1/memory/search");
  assert.equal(search.headers["x-ragionex-vault-id"], undefined);
  assert.equal(mock.state.requests.filter(request => request.url === "/v1/memory/identity").length, 0);
});

test("connection lists account Vaults once and reports an unavailable configured target", async (t) => {
  const mock = await startMock(t);
  const home = tempDir(t);
  putProjectConfig(home, { vault_id: VAULT_B, api_key: KEY_B });
  const client = await connect(t, { home, base: mock.base, key: KEY_A });
  const result = await client.callTool({ name: "ragionex_memory_connection", arguments: {} });
  assert.equal(result.isError, true);
  const report = JSON.parse(text(result));
  assert.equal(report.target_vault_id, VAULT_B);
  assert.equal(report.identity.vaults[0].vault_id, VAULT_A);
  assert.equal(report.error, null);
  assert.equal(report.target_available, false);
  assert.deepEqual(mock.state.requests.map(request => request.headers["x-ragionex-vault-id"]), [undefined]);
  assert.ok(mock.state.requests.every(request => request.headers["x-api-key"] === KEY_B));
  assert.equal(text(result).includes(KEY_A) || text(result).includes(KEY_B), false);
  const denied = await client.callTool({ name: "ragionex_save_memory", arguments: { content: "Do not redirect this." } });
  assert.equal(denied.isError, true);
  assert.deepEqual(pendingFiles(home), []);
  assert.equal(mock.state.records.size, 0);
});

test("a missing default is a service error and the next save reads its repair", async (t) => {
  const mock = await startMock(t);
  const home = tempDir(t);
  const client = await connect(t, { home, base: mock.base, key: KEY_A });
  const save = () => client.callTool({ name: "ragionex_save_memory", arguments: { content: "Keep this after default repair." } });
  mock.state.identity.vaults[0].is_default = false;
  const rejected = await save();
  assert.equal(rejected.isError, true);
  assert.match(text(rejected), /no_vault_bound/);
  assert.deepEqual(pendingFiles(home), []);
  mock.state.identity.vaults[0].is_default = true;
  assert.ok(!(await save()).isError);
  assert.equal(mock.writes().length, 2);
  assert.ok(mock.writes().every(request => request.headers["x-ragionex-vault-id"] === undefined));
  assert.equal(mock.state.requests.some(request => request.url === "/v1/memory/identity"), false);
});

test("Claude project signals OpenCode roots and Codex cwd select their project files", async (t) => {
  const mock = await startMock(t);
  addSecondVault(mock);
  for (const name of ["claude-code", "opencode", "codex-mcp-client"]) {
    const home = tempDir(t);
    const project = path.join(home, "acme-app");
    fs.mkdirSync(project);
    putProjectConfig(project, { vault_id: VAULT_B });
    const client = await connect(t, {
      home, base: mock.base, key: KEY_A, name,
      cwd: name === "codex-mcp-client" ? project : home,
      env: name === "claude-code" ? { CLAUDE_PROJECT_DIR: project } : {},
      ...(name === "opencode" ? { roots: [{ uri: pathToFileURL(project).href, name: "acme-app" }] } : {}),
    });
    const result = await client.callTool({ name: "ragionex_list_memories", arguments: {} });
    assert.ok(!result.isError, text(result));
    assert.equal(mock.state.requests.at(-1).headers["x-ragionex-vault-id"], VAULT_B);
    await client.close();
  }
});

test("ambiguous roots and relative explicit project signals fail without HTTP or staging", async (t) => {
  const mock = await startMock(t);
  const home = tempDir(t);
  putProjectConfig(home, { vault_id: VAULT_A, api_key: KEY_B });
  for (const options of [
    { name: "claude-code", env: { CLAUDE_PROJECT_DIR: "acme-app" } },
    { name: "opencode", roots: [{ uri: pathToFileURL(home).href }, { uri: pathToFileURL(path.join(home, "acme-app")).href }] },
    { name: "opencode", roots: new Error("Folder discovery failed.") },
    { name: "opencode", roots: [] },
    { name: "opencode", roots: [{ uri: "https://example.test/acme-app" }] },
    { name: "opencode", roots: [{ uri: pathToFileURL(home).href + "?project=acme-app" }] },
    { name: "opencode", roots: [{ uri: pathToFileURL(home).href + "#acme-app" }] },
  ]) {
    const client = await connect(t, { home, base: mock.base, key: KEY_A, ...options });
    const result = await client.callTool({ name: "ragionex_save_memory", arguments: { content: "Do not guess a folder." } });
    assert.equal(result.isError, true);
    assert.match(text(result), /config_error/);
    assert.deepEqual(pendingFiles(home), []);
    await client.close();
  }
  assert.deepEqual(mock.state.requests, []);
});

test("successful requests discover the client folder once and empty queues do not rediscover it", async (t) => {
  const mock = await startMock(t);
  const home = tempDir(t);
  let discoveries = 0;
  const client = await connect(t, {
    home, base: mock.base, key: KEY_A, name: "opencode",
    roots: () => {
      discoveries++;
      return [{ uri: pathToFileURL(home).href }];
    },
  });
  await client.callTool({ name: "ragionex_memory_connection", arguments: {} });
  const before = discoveries;
  const result = await client.callTool({ name: "ragionex_list_memories", arguments: {} });
  assert.ok(!result.isError, text(result));
  assert.equal(discoveries, before + 1);
  assert.deepEqual(pendingFiles(home), []);
});

test("runtime stays process-free across refresh requests file changes and replay", async (t) => {
  const mock = await startMock(t);
  addSecondVault(mock);
  const home = tempDir(t);
  const codexHome = path.join(home, ".codex");
  fs.mkdirSync(codexHome);
  const rules = path.join(codexHome, "AGENTS.md");
  fs.writeFileSync(rules, "<!-- ragionex-memory-mcp:priority-rule:begin -->\nold body\n<!-- ragionex-memory-mcp:priority-rule:end -->\n");
  const log = path.join(home, "process-launches.log");
  const client = await connect(t, {
    home, base: mock.base, key: KEY_A, name: "codex-mcp-client",
    env: { CODEX_HOME: codexHome, RAGIONEX_TEST_PROCESS_LOG: log },
    // --import takes a URL; a Windows drive path would be read as an unknown URL scheme.
    nodeArgs: ["--import", new URL("./deny-process.js", import.meta.url).href],
  });
  assert.ok(await waitFor(() => fs.readFileSync(rules, "utf-8").includes(RULE_BODY)));
  putProjectConfig(home, { vault_id: VAULT_A });
  mock.state.replies.write.push({ status: 500 });
  await client.callTool({ name: "ragionex_save_memory", arguments: { content: "Queued for A." } });
  putProjectConfig(home, { vault_id: VAULT_B });
  await client.callTool({ name: "ragionex_memory_connection", arguments: {} });
  assert.ok(await waitFor(() => pendingFiles(home).length === 0));
  assert.equal(mock.writes().at(-1).headers["x-ragionex-vault-id"], VAULT_A);
  assert.ok(!(await client.callTool({ name: "ragionex_save_memory", arguments: { content: "New in B." } })).isError);
  assert.equal(mock.writes().at(-1).headers["x-ragionex-vault-id"], VAULT_B);
  assert.equal(fs.existsSync(log), false);
});
