import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { parse } from "jsonc-parser";
import { PACKAGE, apiKey, connect, machine, startMock, text } from "./helpers.js";

const KEY = apiKey("a");
const NEW_KEY = apiKey("b");
const SERVER = "ragionex-memory-mcp";
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf-8"));
const rules = (file) => fs.existsSync(file) && fs.readFileSync(file, "utf-8").includes("priority-rule:begin");

test("top-level commands print usage or the version", async (t) => {
  const box = machine(t, { clis: [] });
  const version = await box.run(["--version"]);
  assert.equal(version.status, 0);
  assert.equal(version.stdout.trim(), PACKAGE.version);
  const help = await box.run(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage:/);
  const unknown = await box.run(["init"]);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /Unknown command: init/);
  const removedFlag = await box.run(["install", "--remove"]);
  assert.equal(removedFlag.status, 2);
  assert.match(removedFlag.stderr, /Unknown argument: --remove/);
});

test("registration presence reads only the user-scope server map", async (t) => {
  const mock = await startMock(t);
  const mentions = JSON.stringify({ projects: { "/work": { allowedTools: [`mcp__${SERVER}__ragionex_save_memory`] } } });

  const keyless = machine(t);
  fs.writeFileSync(path.join(keyless.home, ".claude.json"), mentions);
  const first = await keyless.run(["install", "--agent", "claude-code"]);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /^Installed for Claude Code/m);
  assert.deepEqual(readJson(path.join(keyless.home, ".claude.json")).mcpServers[SERVER].env, {
    RAGIONEX_API_BASE: "http://127.0.0.1:9",
  });

  const keyed = machine(t);
  const config = path.join(keyed.home, ".claude.json");
  fs.writeFileSync(config, mentions);
  const result = await keyed.run(["install", "--agent", "claude-code", "--api-key", KEY], { RAGIONEX_API_BASE: mock.base });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(keyed.calls().map((call) => call[2]), ["add"]);
  assert.equal(readJson(config).mcpServers[SERVER].env.RAGIONEX_MEMORY_API_KEY, KEY);
  assert.deepEqual(fs.readdirSync(keyed.home).filter((name) => name.includes("ragionex-backup")), []);
  const rerun = await keyed.run(["install", "--agent", "claude-code"]);
  assert.match(rerun.stdout, /Kept the existing registration/);
  assert.equal(readJson(config).mcpServers[SERVER].env.RAGIONEX_MEMORY_API_KEY, KEY);
});

test("a keyed reinstall is checked, then replaces the key through remove and add", async (t) => {
  const mock = await startMock(t);
  const box = machine(t);
  const env = { RAGIONEX_API_BASE: mock.base };
  assert.equal((await box.run(["install", "--agent", "claude-code", "--api-key", KEY], env)).status, 0);
  const result = await box.run(["install", "--agent", "claude-code", "--api-key", NEW_KEY], env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Key verified \(permissions:/);
  assert.ok(mock.state.requests.some((request) => request.url === "/v1/memory/identity" && request.headers["x-api-key"] === NEW_KEY));
  assert.deepEqual(box.calls().slice(-2).map((call) => call[2]), ["remove", "add"]);
  assert.equal(readJson(path.join(box.home, ".claude.json")).mcpServers[SERVER].env.RAGIONEX_MEMORY_API_KEY, NEW_KEY);
  assert.deepEqual(fs.readdirSync(box.home).filter((name) => name.includes("ragionex-backup")), []);
});

test("a rejected key stops the install before any change", async (t) => {
  const mock = await startMock(t);
  mock.state.replies.identity.push({ status: 401, body: { success: false, error: "Invalid API key" } });
  const box = machine(t);
  const result = await box.run(["install", "--agent", "claude-code", "--api-key", KEY], { RAGIONEX_API_BASE: mock.base });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /rejected/);
  assert.deepEqual(box.calls(), []);
  assert.equal(rules(path.join(box.home, ".claude", "CLAUDE.md")), false);
});

test("an unavailable service only warns, and a malformed key is refused without a request", async (t) => {
  const mock = await startMock(t);
  mock.state.replies.identity.push({ status: 503, headers: { "Retry-After": "5" } });
  const box = machine(t);
  const busy = await box.run(["install", "--agent", "claude-code", "--api-key", KEY], { RAGIONEX_API_BASE: mock.base });
  assert.equal(busy.status, 0, busy.stderr);
  assert.match(busy.stderr, /could not be checked \(HTTP 503\)/);
  const offline = await box.run(["install", "--agent", "claude-code", "--api-key", NEW_KEY]);
  assert.equal(offline.status, 0, offline.stderr);
  assert.match(offline.stderr, /could not be checked/);
  const requests = mock.state.requests.length;
  const malformed = await box.run(["install", "--agent", "claude-code", "--api-key", "rgx_memory_not a key"], { RAGIONEX_API_BASE: mock.base });
  assert.equal(malformed.status, 2);
  assert.equal(mock.state.requests.length, requests);
});

test("relocated agent homes hold the rule and reach the server environment", async (t) => {
  const mock = await startMock(t);
  const box = machine(t, { folders: [] });
  // Spaced paths prove each relocated home reaches the CLI as one argument on Windows too.
  const claudeHome = path.join(box.root, "work claude");
  const codexHome = path.join(box.root, "work codex");
  fs.mkdirSync(claudeHome);
  fs.mkdirSync(codexHome);
  const result = await box.run(["install", "--all-agents", "--api-key", KEY], {
    RAGIONEX_API_BASE: mock.base,
    CLAUDE_CONFIG_DIR: claudeHome,
    CODEX_HOME: codexHome,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(rules(path.join(claudeHome, "CLAUDE.md")));
  assert.ok(rules(path.join(codexHome, "AGENTS.md")));
  assert.equal(readJson(path.join(claudeHome, ".claude.json")).mcpServers[SERVER].env.CLAUDE_CONFIG_DIR, claudeHome);
  assert.ok(fs.readFileSync(path.join(codexHome, "config.toml"), "utf-8").includes(`CODEX_HOME = ${JSON.stringify(codexHome)}`));
  assert.equal(fs.existsSync(path.join(box.home, ".claude")), false);
  assert.equal(fs.existsSync(path.join(box.home, ".codex")), false);
});

test("a missing agent CLI prints the command to run by hand", async (t) => {
  const box = machine(t, { clis: [], folders: [".codex"] });
  const result = await box.run(["install", "--agent", "codex"]);
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes(`codex mcp add ${SERVER} --env RAGIONEX_MEMORY_API_KEY=<your-api-key> --env RAGIONEX_API_BASE=http://127.0.0.1:9 -- npx -y @ragionex/memory-mcp@latest`), result.stderr);
});

test("a failed registration shows the CLI output without the key and keeps the config copy", async (t) => {
  const mock = await startMock(t);
  const box = machine(t);
  fs.writeFileSync(path.join(box.home, ".claude.json"), "{}");
  const result = await box.run(["install", "--agent", "claude-code", "--api-key", KEY], { RAGIONEX_API_BASE: mock.base, STUB_FAIL: "claude mcp add" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /simulated failure/);
  assert.match(result.stderr, /rgx_memory_\*\*\*/);
  assert.equal(result.stderr.includes(KEY), false);
  const copies = fs.readdirSync(box.home).filter((name) => name.startsWith(".claude.json.ragionex-backup-"));
  assert.equal(copies.length, 1);
  assert.ok(result.stderr.includes(copies[0]));
});

test("rules files are replaced through symlinks with their mode, and unreadable ones are left alone", async (t) => {
  const box = machine(t, { folders: [".claude", "dotfiles"] });
  const target = path.join(box.home, "dotfiles", "CLAUDE.md");
  fs.writeFileSync(target, "# My rules\n");
  fs.chmodSync(target, 0o640);
  const link = path.join(box.home, ".claude", "CLAUDE.md");
  fs.symlinkSync(target, link);
  const result = await box.run(["install", "--agent", "claude-code"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.ok(fs.readFileSync(target, "utf-8").startsWith("# My rules\n"));
  assert.ok(rules(target));
  // Windows has no POSIX mode bits; profile files inherit the user's ACL instead.
  if (process.platform !== "win32") assert.equal(fs.statSync(target).mode & 0o777, 0o640);

  const other = machine(t, { folders: [path.join(".claude", "CLAUDE.md")] });
  const blocked = await other.run(["install", "--agent", "claude-code"]);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /Could not read/);
  assert.equal(fs.statSync(path.join(other.home, ".claude", "CLAUDE.md")).isDirectory(), true);
});

test("OpenCode uninstall keeps comments and restores a config OpenCode cannot load", async (t) => {
  const box = machine(t, { folders: [path.join(".config", "opencode")] });
  const config = path.join(box.home, ".config", "opencode", "opencode.jsonc");
  const original = [
    "{",
    "  // kept by the user",
    '  "mcp": {',
    '    "other": { "type": "local", "command": ["other-server"] },',
    `    "${SERVER}": { "type": "local", "command": ["npx", "-y", "@ragionex/memory-mcp"] }`,
    "  }",
    "}",
    "",
  ].join("\n");
  fs.writeFileSync(config, original);
  const rejected = await box.run(["uninstall", "--agent", "opencode"], { STUB_FAIL: "opencode mcp list" });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /restored/);
  assert.equal(fs.readFileSync(config, "utf-8"), original);
  const result = await box.run(["uninstall", "--agent", "opencode"]);
  assert.equal(result.status, 0, result.stderr);
  const edited = fs.readFileSync(config, "utf-8");
  assert.match(edited, /\/\/ kept by the user/);
  assert.match(edited, /"other"/);
  assert.equal(edited.includes(`"${SERVER}"`), false);
});

test("uninstall names itself in its hints and reports kept local saves", async (t) => {
  const box = machine(t, { folders: [".claude", ".codex"] });
  const connection = path.join(box.home, ".ragionex", "pending-saves", "c".repeat(64));
  fs.mkdirSync(connection, { recursive: true });
  fs.writeFileSync(path.join(connection, `${randomUUID()}.pending.json`), "{}");
  fs.writeFileSync(path.join(connection, `${randomUUID()}.blocked-invalid_request.json`), "{}");
  const ambiguous = await box.run(["uninstall"]);
  assert.equal(ambiguous.status, 2);
  assert.match(ambiguous.stderr, /uninstall --agent claude-code/);
  assert.equal(ambiguous.stderr.includes("--api-key"), false);
  const result = await box.run(["uninstall", "--all-agents"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 still waiting to sync/);
  assert.match(result.stdout, /1 blocked for review/);
});

test("all installer targets launch the latest package tag", async (t) => {
  const box = machine(t, { folders: [".claude", ".codex", path.join(".config", "opencode")] });
  const result = await box.run(["install", "--all-agents"]);
  assert.equal(result.status, 0, result.stderr);
  const additions = box.calls().filter((call) => call[2] === "add");
  assert.equal(additions.length, 3);
  for (const call of additions) {
    const launch = call.slice(call.indexOf("--") + 1);
    const expected = call[0] === "claude" && process.platform === "win32"
      ? ["cmd", "/c", "npx", "-y", "@ragionex/memory-mcp@latest"]
      : ["npx", "-y", "@ragionex/memory-mcp@latest"];
    assert.deepEqual(launch, expected);
  }
});

test("an existing launch is preserved without a key and upgraded with the same key", async (t) => {
  const mock = await startMock(t);
  const box = machine(t);
  const config = path.join(box.home, ".claude.json");
  fs.writeFileSync(config, JSON.stringify({
    mcpServers: {
      [SERVER]: { command: "npx", args: ["-y", "@ragionex/memory-mcp"], env: { RAGIONEX_MEMORY_API_KEY: KEY } },
    },
  }));
  const original = fs.readFileSync(config, "utf-8");
  const keyless = await box.run(["install", "--agent", "claude-code"]);
  assert.equal(keyless.status, 0, keyless.stderr);
  assert.match(keyless.stdout, /Kept the existing registration/);
  assert.equal(fs.readFileSync(config, "utf-8"), original);
  const keyed = await box.run(["install", "--agent", "claude-code", "--api-key", KEY], { RAGIONEX_API_BASE: mock.base });
  assert.equal(keyed.status, 0, keyed.stderr);
  const registered = readJson(config).mcpServers[SERVER];
  assert.deepEqual(registered.args, process.platform === "win32"
    ? ["/c", "npx", "-y", "@ragionex/memory-mcp@latest"]
    : ["-y", "@ragionex/memory-mcp@latest"]);
  assert.equal(registered.env.RAGIONEX_MEMORY_API_KEY, KEY);
});

test("all registrations retain the normalized address used for key validation", async (t) => {
  const mock = await startMock(t);
  const box = machine(t, { folders: [".claude", ".codex", path.join(".config", "opencode")] });
  const result = await box.run(["install", "--all-agents", "--api-key", KEY], { RAGIONEX_API_BASE: mock.base + "///" });
  assert.equal(result.status, 0, result.stderr);
  const additions = box.calls().filter(call => call[2] === "add");
  assert.equal(additions.length, 3);
  for (const call of additions) assert.ok(call.includes(`RAGIONEX_API_BASE=${mock.base}`));
  const claude = readJson(path.join(box.home, ".claude.json")).mcpServers[SERVER].env;
  assert.equal(claude.RAGIONEX_API_BASE, mock.base);
  assert.ok(fs.readFileSync(path.join(box.home, ".codex", "config.toml"), "utf-8").includes(`RAGIONEX_API_BASE = "${mock.base}"`));
  assert.equal(parse(fs.readFileSync(path.join(box.home, ".config", "opencode", "opencode.jsonc"), "utf-8")).mcp[SERVER].environment.RAGIONEX_API_BASE, mock.base);
  const client = await connect(t, { home: box.home, env: claude });
  const connection = await client.callTool({ name: "ragionex_memory_connection", arguments: {} });
  assert.ok(!connection.isError, text(connection));
  assert.equal(mock.state.requests.filter(request => request.url === "/v1/memory/identity").length, 2);
});

test("keyless registration carries an override and omits an unset override", async (t) => {
  for (const base of ["http://127.0.0.1:9/", undefined]) {
    const box = machine(t);
    const result = await box.run(["install", "--agent", "claude-code"], { RAGIONEX_API_BASE: base });
    assert.equal(result.status, 0, result.stderr);
    const environment = readJson(path.join(box.home, ".claude.json")).mcpServers[SERVER].env;
    assert.equal(environment.RAGIONEX_API_BASE, base === undefined ? undefined : "http://127.0.0.1:9");
    assert.equal(Object.hasOwn(environment, "RAGIONEX_MEMORY_API_KEY"), false);
  }
});

test("an invalid install address is refused before any CLI or rule change", async (t) => {
  for (const args of [
    ["install", "--agent", "claude-code"],
    ["install", "--agent", "claude-code", "--api-key", KEY],
  ]) {
    const box = machine(t);
    const result = await box.run(args, { RAGIONEX_API_BASE: "http://api.example.test" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must use HTTPS/);
    assert.deepEqual(box.calls(), []);
    assert.equal(fs.existsSync(path.join(box.home, ".claude.json")), false);
    assert.equal(rules(path.join(box.home, ".claude", "CLAUDE.md")), false);
  }
});

for (const position of ["only", "first", "middle", "last", "trailing"]) {
  test(`OpenCode removes only the exact ${position} registration and preserves surrounding JSONC bytes`, async (t) => {
    const box = machine(t, { folders: [path.join(".config", "opencode")] });
    const config = path.join(box.home, ".config", "opencode", "opencode.jsonc");
    const target = `"${SERVER}": { "type": "local", "command": ["npx"], "note": "braces } and escaped quote \\" stay in strings" }`;
    const left = '"left": { "type": "local", "command": ["left-server"] }';
    const right = '"right": { "type": "local", "command": ["right-server"] }';
    let members;
    let expectedMembers;
    if (position === "only") {
      members = `/* before */ ${target} /* after */`;
      expectedMembers = "/* before */  /* after */";
    } else if (position === "first") {
      members = `/* before */ ${target}, /* keep right */ ${right}`;
      expectedMembers = `/* before */  /* keep right */ ${right}`;
    } else if (position === "middle") {
      members = `${left}, /* before */ ${target}, /* keep right */ ${right}`;
      expectedMembers = `${left}, /* before */  /* keep right */ ${right}`;
    } else if (position === "last") {
      members = `${left}, /* before */ ${target} /* after */`;
      expectedMembers = `${left} /* before */  /* after */`;
    } else {
      members = `${left}, /* before */ ${target}, /* after */`;
      expectedMembers = `${left}, /* before */  /* after */`;
    }
    const prefix = `{\n  // Example: "mcp": { "${SERVER}": {} }\n  "nested": { "mcp": { "${SERVER}": {} } },\n  "mcp": {\n    `;
    const suffix = "\n  },\n  \"keep\": true,\n}\n";
    const original = prefix + members + suffix;
    fs.writeFileSync(config, original);
    fs.chmodSync(config, 0o640);
    const result = await box.run(["uninstall", "--agent", "opencode"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(config, "utf-8"), prefix + expectedMembers + suffix);
    assert.equal(Object.hasOwn(parse(fs.readFileSync(config, "utf-8")).mcp, SERVER), false);
    // Windows has no POSIX mode bits; profile files inherit the user's ACL instead.
    if (process.platform !== "win32") assert.equal(fs.statSync(config).mode & 0o777, 0o640);
    const copies = fs.readdirSync(path.dirname(config)).filter(name => name.includes("ragionex-backup"));
    assert.equal(copies.length, 1);
    assert.equal(fs.readFileSync(path.join(path.dirname(config), copies[0]), "utf-8"), original);
    const again = await box.run(["uninstall", "--agent", "opencode"]);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(fs.readFileSync(config, "utf-8"), prefix + expectedMembers + suffix);
  });
}

test("OpenCode refuses an ambiguous duplicate member without modifying user bytes", async (t) => {
  const box = machine(t, { folders: [path.join(".config", "opencode")] });
  const config = path.join(box.home, ".config", "opencode", "opencode.jsonc");
  const original = `{"mcp":{"${SERVER}":{},"${SERVER}":{}}}\n`;
  fs.writeFileSync(config, original);
  const result = await box.run(["uninstall", "--agent", "opencode"]);
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(config, "utf-8"), original);
});
