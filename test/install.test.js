import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { parse } from "jsonc-parser";
import { PACKAGE, SETUP, machine, startMock } from "./helpers.js";

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

test("relocated agent homes hold the rule and reach the server environment", async (t) => {
  const mock = await startMock(t);
  const box = machine(t, { folders: [] });
  // Spaced paths prove each relocated home reaches the CLI as one argument on Windows too.
  const claudeHome = path.join(box.root, "work claude");
  const codexHome = path.join(box.root, "work codex");
  fs.mkdirSync(claudeHome);
  fs.mkdirSync(codexHome);
  const result = await box.run(["install", "--all-agents", ...SETUP], {
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

test("rules files are replaced through symlinks with their mode, and unreadable ones are left alone", async (t) => {
  const mock = await startMock(t);
  const box = machine(t, { folders: [".claude", "dotfiles"] });
  const target = path.join(box.home, "dotfiles", "CLAUDE.md");
  fs.writeFileSync(target, "# My rules\n");
  fs.chmodSync(target, 0o640);
  const link = path.join(box.home, ".claude", "CLAUDE.md");
  fs.symlinkSync(target, link);
  const result = await box.run(["install", "--agent", "claude-code", ...SETUP], { RAGIONEX_API_BASE: mock.base });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.ok(fs.readFileSync(target, "utf-8").startsWith("# My rules\n"));
  assert.ok(rules(target));
  // Windows has no POSIX mode bits; profile files inherit the user's ACL instead.
  if (process.platform !== "win32") assert.equal(fs.statSync(target).mode & 0o777, 0o640);

  const other = machine(t, { folders: [path.join(".claude", "CLAUDE.md")] });
  const blocked = await other.run(["install", "--agent", "claude-code", ...SETUP], { RAGIONEX_API_BASE: mock.base });
  assert.equal(blocked.status, 1);
  assert.match(blocked.stdout, /is not ready for Claude Code: .*could not be read/);
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
  const mock = await startMock(t);
  const box = machine(t, { folders: [".claude", ".codex", path.join(".config", "opencode")] });
  const result = await box.run(["install", "--all-agents", ...SETUP], { RAGIONEX_API_BASE: mock.base });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const additions = box.calls().filter((call) => call[2] === "add");
  assert.equal(additions.length, 3);
  for (const call of additions) {
    assert.deepEqual(call.slice(call.indexOf("--") + 1), process.platform === "win32"
      ? ["cmd", "/c", "npx", "-y", "@ragionex/memory-mcp@latest"]
      : ["npx", "-y", "@ragionex/memory-mcp@latest"]);
  }
});

test("an invalid install address is refused before any CLI or rule change", async (t) => {
  for (const args of [
    ["install", "--agent", "claude-code", ...SETUP],
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
