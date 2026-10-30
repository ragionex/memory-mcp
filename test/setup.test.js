import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { AGENT_CLI_STUB, SETUP, apiKey, connect, machine, startMock, tempDir } from "./helpers.js";

const SERVER = "ragionex-memory-mcp";
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf-8"));
const claudeEnv = (home) => readJson(path.join(home, ".claude.json")).mcpServers[SERVER].env;
const hasRule = (file) => fs.existsSync(file) && fs.readFileSync(file, "utf-8").includes("priority-rule:begin");
const setupRequests = (mock) => mock.state.requests.filter((request) => request.url.startsWith("/v1/setup/"));

test("an agent run asks for the email, sends a code, then connects with it", async (t) => {
  const mock = await startMock(t);
  const box = machine(t);
  const env = { RAGIONEX_API_BASE: mock.base };
  const first = await box.run(["install"], env);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /install --agent claude-code --email <address>/);
  assert.match(first.stdout, /you agree to the Ragionex Terms of Service[\s\S]*Next step:/);
  assert.deepEqual(mock.state.requests, []);

  const second = await box.run(["install", "--email", " User@Example.com "], env);
  assert.equal(second.status, 0, second.stderr);
  assert.ok(second.stdout.indexOf("you agree to the Ragionex Terms") < second.stdout.indexOf("A one-time code was sent to user@example.com"));
  assert.match(second.stdout, /install --agent claude-code --email user@example\.com --code <code>/);
  assert.deepEqual(setupRequests(mock).map((request) => [request.url, request.body]), [["/v1/setup/code", { email: "user@example.com" }]]);
  assert.deepEqual(box.calls(), []);

  // Project-scope mentions of the server are not a user-scope registration.
  fs.writeFileSync(path.join(box.home, ".claude.json"), JSON.stringify({ projects: { "/work": { allowedTools: [`mcp__${SERVER}__ragionex_save_memory`] } } }));
  const third = await box.run(["install", "--agent", "claude-code", ...SETUP], env);
  assert.equal(third.status, 0, third.stdout + third.stderr);
  assert.match(third.stdout, /Ragionex Memory is ready: Claude Code is connected to user@example\.com\./);
  assert.match(third.stdout, /Check my Ragionex Memory connection/);
  const [key] = mock.state.issued;
  assert.equal(claudeEnv(box.home).RAGIONEX_MEMORY_API_KEY, key);
  assert.equal(third.stdout.includes(key) || third.stderr.includes(key), false);
  assert.deepEqual(box.calls().map((call) => call[2]), ["add"]);
  assert.ok(hasRule(path.join(box.home, ".claude", "CLAUDE.md")));
  const verify = setupRequests(mock).find((request) => request.url === "/v1/setup/verify");
  assert.deepEqual(Object.keys(verify.body), ["email", "code", "keys"]);
  assert.equal(verify.body.code, "K7QFM2XR");
  assert.match(verify.body.keys[0].name, /^Claude Code \(set up \d{4}-\d{2}-\d{2}\)$/);
  assert.ok(mock.state.requests.some((request) => request.url === "/v1/memory/identity" && request.headers["x-api-key"] === key));
});

test("a reinstall gives the agent a new key and revokes nothing", async (t) => {
  const mock = await startMock(t);
  const box = machine(t);
  const env = { RAGIONEX_API_BASE: mock.base };
  fs.writeFileSync(path.join(box.home, ".claude.json"), JSON.stringify({
    mcpServers: { [SERVER]: { command: "npx", args: ["-y", "@ragionex/memory-mcp"], env: { RAGIONEX_MEMORY_API_KEY: apiKey("a") } } },
  }));
  const upgrade = await box.run(["install", "--agent", "claude-code", ...SETUP], env);
  assert.equal(upgrade.status, 0, upgrade.stdout + upgrade.stderr);
  const again = await box.run(["install", "--agent", "claude-code", ...SETUP], env);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  const [, second] = mock.state.issued;
  assert.equal(claudeEnv(box.home).RAGIONEX_MEMORY_API_KEY, second);
  assert.deepEqual(setupRequests(mock).map((request) => request.url), ["/v1/setup/verify", "/v1/setup/verify"]);
  assert.deepEqual(box.calls().map((call) => call[2]), ["remove", "add", "remove", "add"]);
  assert.deepEqual(fs.readdirSync(box.home).filter((name) => name.includes("ragionex-backup")), []);
});

test("a wrong, expired or malformed code changes nothing and names the next step", async (t) => {
  const mock = await startMock(t);
  const box = machine(t);
  const env = { RAGIONEX_API_BASE: mock.base };
  const wrong = await box.run(["install", "--email", "user@example.com", "--code", "AAAA-BBBB"], env);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stdout, /is not ready: the code is not correct\./);
  assert.match(wrong.stdout, /--email user@example\.com --code <code>/);
  mock.state.replies.setupVerify.push({ status: 400, body: { success: false, error: "This code has expired.", code: "code_expired" } });
  const expired = await box.run(["install", ...SETUP], env);
  assert.equal(expired.status, 1);
  assert.match(expired.stdout, /has expired/);
  assert.match(expired.stdout, /install --agent claude-code --email user@example\.com\n/);
  const requests = mock.state.requests.length;
  const malformed = await box.run(["install", "--email", "user@example.com", "--code", "12"], env);
  assert.equal(malformed.status, 1);
  assert.match(malformed.stdout, /the code is not correct/);
  assert.equal(mock.state.requests.length, requests);
  assert.deepEqual(box.calls(), []);
  assert.equal(hasRule(path.join(box.home, ".claude", "CLAUDE.md")), false);
  assert.deepEqual(mock.state.issued, []);
});

test("an unreachable service changes nothing and says what to do", async (t) => {
  const box = machine(t);
  const result = await box.run(["install", "--email", "user@example.com"]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /is not ready: Ragionex could not be reached/);
  assert.match(result.stdout, /install --agent claude-code --email user@example\.com\n/);
  assert.deepEqual(box.calls(), []);
});

test("a printed command never carries an address with shell characters", async (t) => {
  const box = machine(t);
  const result = await box.run(["install", "--email", "a`id`$b@example.com"]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /install --agent claude-code --email <address>\n/);
  assert.equal(result.stdout.includes("`id`"), false);
});

test("a missing agent command stops the setup before a code is sent", async (t) => {
  const mock = await startMock(t);
  const box = machine(t, { clis: [], folders: [".codex"] });
  const result = await box.run(["install", "--agent", "codex", "--email", "user@example.com"], { RAGIONEX_API_BASE: mock.base });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /the `codex` command was not found/);
  assert.deepEqual(mock.state.requests, []);
});

test("a failed registration names its unused key, keeps the settings and never shows the key", async (t) => {
  const mock = await startMock(t);
  const box = machine(t);
  fs.writeFileSync(path.join(box.home, ".claude.json"), "{}");
  const result = await box.run(["install", ...SETUP], { RAGIONEX_API_BASE: mock.base, STUB_FAIL: "claude mcp add" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /is not ready for Claude Code: the Ragionex entry could not be added \(.*simulated failure\)\. Its settings were not changed\./);
  assert.match(result.stdout, /The new key "Claude Code \(set up \d{4}-\d{2}-\d{2}\)" \(#1\) is not needed; you can revoke it at https:\/\/app\.ragionex\.com\/keys\.\n/);
  assert.match(result.stdout, /rgx_memory_\*\*\*/);
  const [key] = mock.state.issued;
  assert.equal(result.stdout.includes(key) || result.stderr.includes(key), false);
  assert.deepEqual(setupRequests(mock).map((request) => request.url), ["/v1/setup/verify"]);
  assert.deepEqual(fs.readdirSync(box.home).filter((name) => name.includes("ragionex-backup")), []);
});

test("the retired --api-key flag points to the new setup without echoing the key", async (t) => {
  const box = machine(t);
  const key = apiKey("a");
  const result = await box.run(["install", "--agent", "claude-code", "--api-key", key]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--api-key is no longer used/);
  assert.equal(result.stdout.includes(key) || result.stderr.includes(key), false);
  assert.deepEqual(box.calls(), []);
});

test("Codex gets the rule in AGENTS.override.md when that file is in use", async (t) => {
  const mock = await startMock(t);
  const box = machine(t, { folders: [".codex"] });
  const override = path.join(box.home, ".codex", "AGENTS.override.md");
  fs.writeFileSync(override, "# Temporary instructions\n");
  const result = await box.run(["install", "--agent", "codex", ...SETUP], { RAGIONEX_API_BASE: mock.base });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(hasRule(override));
  assert.equal(fs.existsSync(path.join(box.home, ".codex", "AGENTS.md")), false);
});

test("a Claude Code copy of the desktop app is found off PATH, newest version first", { skip: process.platform === "win32" }, async (t) => {
  const mock = await startMock(t);
  const box = machine(t, { clis: [] });
  const data = process.platform === "darwin"
    ? path.join(box.home, "Library", "Application Support")
    : path.join(box.home, ".config");
  const copy = (folder, body) => {
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "claude"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  };
  copy(path.join(data, "Claude", "claude-code", "2.1.9"), "exit 1");
  copy(path.join(data, "Claude-Data", "claude_test", "claude-code", "2.1.10", "c17a819afb40"),
    `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(AGENT_CLI_STUB)} claude "$@"`);
  const result = await box.run(["install", "--agent", "claude-code", ...SETUP], { RAGIONEX_API_BASE: mock.base });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Using Claude Code found at .*2\.1\.10.*\.\n/);
  assert.deepEqual(box.calls().map((call) => call.slice(0, 3)), [["claude", "mcp", "add"]]);
});

test("with no Claude Code to run, the setup asks to be run from Claude Code itself", async (t) => {
  const mock = await startMock(t);
  const box = machine(t, { clis: [] });
  const result = await box.run(["install", "--agent", "claude-code", "--email", "user@example.com"], { RAGIONEX_API_BASE: mock.base });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /so the setup runs from Claude Code itself:\n  Set up Ragionex Memory for me: run npx -y @ragionex\/memory-mcp@latest install and follow its instructions\.\n/);
  assert.deepEqual(mock.state.requests, []);
});

test("the connection check offers an import only while the Vault is empty", async (t) => {
  const mock = await startMock(t);
  const home = tempDir(t);
  const client = await connect(t, { home, base: mock.base, key: apiKey("a"), name: "claude-code" });
  const empty = await client.callTool({ name: "ragionex_memory_connection", arguments: {} });
  assert.equal(empty.content.length, 2);
  assert.match(empty.content[1].text, /This Vault has no memories yet/);
  assert.ok(empty.content[1].text.includes(path.join(home, ".claude", "CLAUDE.md")));
  // The mock lists nothing unless scripted; one stored memory ends the offer.
  mock.state.replies.list.push({ status: 200, body: { success: true, memories: [{ id: "m1", content: "The user prefers dark mode." }], next_cursor: null } });
  const filled = await client.callTool({ name: "ragionex_memory_connection", arguments: {} });
  assert.equal(filled.content.length, 1);
});
