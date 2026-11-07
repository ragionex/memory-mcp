import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { LINK, SETUP, machine, startMock } from "./helpers.js";

const SERVER = "ragionex-memory-mcp";
const COMMAND = `${process.platform === "win32" ? "npx.cmd" : "npx"} -y @ragionex/memory-mcp@latest`;
const LAUNCH = process.platform === "win32"
  ? ["cmd", "/c", "npx", "-y", "@ragionex/memory-mcp@latest"]
  : ["npx", "-y", "@ragionex/memory-mcp@latest"];
const IDENTITY = "You are a helpful assistant.\n";
const READY = [
  "AI agents: the setup just added the Ragionex Memory rule to your global instructions file, so it may now appear in this conversation. It is already in place and takes effect in the new session.",
  "",
  "Ragionex Memory is ready: Hermes Agent is connected.",
  "",
  "Hermes Agent starts new connections in the background within about 2 minutes. After that, start a new Hermes Agent session (type /new), so Ragionex Memory loads. From then on it works on its own.",
  "",
].join("\n");
const WAIT_NOTICE = "Hermes Agent keeps its connections running in the background, so it needs about 2 minutes to let go of the old Ragionex Memory connection. The setup waits, then adds the new one.\n";
const UNINSTALL_NOTICE = "Hermes Agent keeps its connections running in the background, so it needs about 2 minutes to let go of the Ragionex Memory connection. The setup waits until then.\n";
const FINISH = "Start a new Hermes Agent session (type /new) to finish. Its key stays in your account;";
const ANNOUNCE = "AI agents: the next step takes about 2 minutes. This is how Hermes Agent works: it keeps its connections running in the background and needs that time to let go of the old Ragionex Memory connection. Tell the user this before you run it, so they know it is not stuck, and give the command a time limit of at least 5 minutes.\n";
const ruled = (body) => `${IDENTITY}\n<!-- ragionex-memory-mcp:priority-rule:begin -->\n${body}\n<!-- ragionex-memory-mcp:priority-rule:end -->\n`;
const hasRule = (file) => fs.existsSync(file) && fs.readFileSync(file, "utf-8").includes("priority-rule:begin");
// What each Hermes add or remove read from its standard input, in order.
const inputs = (box) => fs.readFileSync(path.join(box.home, "hermes-input.log"), "utf-8").trim().split("\n").map((line) => JSON.parse(line));

// The environment that makes an installer run record each long wait in the CLI call log instead of spending it.
function recordWaits(box) {
  const preload = path.join(box.root, "record-wait.cjs");
  fs.writeFileSync(preload, [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    "const wait = setTimeout;",
    "globalThis.setTimeout = (callback, ms, ...rest) => {",
    "  if (ms < 100000) return wait(callback, ms, ...rest);",
    '  fs.appendFileSync(path.join(process.env.HOME, "cli-calls.log"), JSON.stringify(["wait", ms]) + "\\n");',
    "  return wait(callback, 0, ...rest);",
    "};",
    "",
  ].join("\n"));
  return { NODE_OPTIONS: `--require "${preload.replace(/\\/g, "/")}"` };
}

// A machine with only the Hermes stub, and a Hermes home that holds its identity file.
function hermesBox(t, clis = ["hermes"]) {
  const box = machine(t, { clis, folders: [".hermes"] });
  const hermesHome = path.join(box.home, ".hermes");
  const soul = path.join(hermesHome, "SOUL.md");
  fs.writeFileSync(soul, IDENTITY);
  return { box, soul, config: path.join(hermesHome, "config.yaml"), env: { HERMES_HOME: hermesHome, ...recordWaits(box) } };
}

test("Hermes Agent gets its entry once with the key through its own command, the rule after its identity, and an uninstall that restores both and waits only after it removed the entry", async (t) => {
  const mock = await startMock(t);
  const { box, soul, config, env } = hermesBox(t);
  const menu = await box.run(["install"], env);
  assert.match(menu.stdout, /\n {2}4\) Hermes Agent \(found\)\n {2}5\) My agent is not in the list \(manual setup\)\n/);

  const result = await box.run(["install", "--agent", "hermes", ...SETUP], { RAGIONEX_API_BASE: mock.base, ...env });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout, READY);
  const [key] = mock.state.issued;
  assert.deepEqual(box.calls(), [
    ["hermes", "config", "path"],
    ["hermes", "mcp", "add", SERVER, "--command", LAUNCH[0], "--env", `RAGIONEX_MEMORY_API_KEY=${key}`,
      `RAGIONEX_API_BASE=${mock.base}`, `RAGIONEX_MEMORY_INSTRUCTIONS_FILE=${soul}`, "--args", ...LAUNCH.slice(1)],
  ]);
  // One Enter enables every tool; nothing else is answered.
  assert.deepEqual(inputs(box), ["\n"]);
  const saved = fs.readFileSync(config, "utf-8");
  assert.ok(saved.includes(key) && saved.includes("    enabled: true"), saved);
  assert.ok(fs.readFileSync(soul, "utf-8").startsWith(`${IDENTITY}\n<!-- ragionex-memory-mcp:priority-rule:begin -->\n`));
  assert.equal(result.stdout.includes(key) || result.stderr.includes(key), false);

  const removed = await box.run(["uninstall", "--agent", "hermes"], env);
  assert.equal(removed.status, 0, removed.stdout + removed.stderr);
  assert.ok(removed.stdout.startsWith(`${UNINSTALL_NOTICE}Ragionex Memory is removed from Hermes Agent: its MCP server and its rule in the global instructions file.\n\n${FINISH}`), removed.stdout);
  assert.equal(fs.readFileSync(soul, "utf-8"), IDENTITY);
  assert.equal(fs.readFileSync(config, "utf-8").includes(SERVER), false);
  // With no entry left to remove, uninstall has nothing to wait for.
  const again = await box.run(["uninstall", "--agent", "hermes"], env);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.ok(again.stdout.startsWith(`Ragionex Memory is removed from Hermes Agent: its MCP server.\n\n${FINISH}`), again.stdout);
  // The wait follows the removal; closed input is Hermes' yes to it.
  assert.deepEqual(box.calls().slice(2), [
    ["hermes", "config", "path"], ["hermes", "mcp", "remove", SERVER], ["wait", 130000],
    ["hermes", "config", "path"], ["hermes", "mcp", "remove", SERVER],
  ]);
  assert.deepEqual(inputs(box), ["\n", "", ""]);
});

test("a re-setup removes the old Hermes entry, waits until Hermes Agent lets go of it, then adds the new one", async (t) => {
  const mock = await startMock(t);
  const { box, soul, config, env } = hermesBox(t);
  // An entry left by manual setup before its placeholders were filled.
  fs.writeFileSync(config, [
    "model: test-model",
    "mcp_servers:",
    `  ${SERVER}:`,
    "    command: npx",
    "    args:",
    "    - -y",
    "    - '@ragionex/memory-mcp@latest'",
    "    env:",
    "      RAGIONEX_MEMORY_API_KEY: SETUP_FILLS_KEY",
    "      RAGIONEX_MEMORY_INSTRUCTIONS_FILE: SETUP_FILLS_PATH",
    "  other:",
    "    command: other-server",
    "",
  ].join("\n"));
  fs.writeFileSync(soul, ruled("old body"));
  const result = await box.run(["install", "--agent", "hermes", ...SETUP], { RAGIONEX_API_BASE: mock.base, ...env });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(box.calls().map((call) => call.slice(0, 3)), [
    ["hermes", "config", "path"],
    ["hermes", "mcp", "remove"],
    ["wait", 130000],
    ["hermes", "mcp", "add"],
  ]);
  assert.equal(result.stdout, WAIT_NOTICE + READY);
  assert.deepEqual(inputs(box), ["", "\n"]);
  const [key] = mock.state.issued;
  const saved = fs.readFileSync(config, "utf-8");
  assert.ok(saved.startsWith("model: test-model\n"), saved);
  assert.ok(saved.includes("  other:\n    command: other-server"), saved);
  assert.equal(saved.split(`  ${SERVER}:`).length, 2, saved);
  assert.ok(saved.includes(key) && !saved.includes("SETUP_FILLS"), saved);
  const rules = fs.readFileSync(soul, "utf-8");
  assert.ok(rules.startsWith(IDENTITY) && hasRule(soul) && !rules.includes("old body"), rules);
  assert.deepEqual(fs.readdirSync(path.dirname(config)).filter((name) => name.startsWith("config.yaml.ragionex-backup")), []);
});

test("the link step tells AI agents about the coming wait only when the Hermes entry is already there", async (t) => {
  const mock = await startMock(t);
  const { box, config, env } = hermesBox(t);
  const linkStep = () => box.run(["install", "--agent", "hermes"], { RAGIONEX_API_BASE: mock.base, ...env });
  const next = `  ${COMMAND} install --agent-mode --agent hermes --link ${LINK} --code <code>\n`;
  const first = await linkStep();
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.ok(first.stdout.endsWith(next), first.stdout);

  const entry = ["mcp_servers:", `  ${SERVER}:`, "    command: npx", ""].join("\n");
  fs.writeFileSync(config, entry);
  const again = await linkStep();
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.ok(again.stdout.endsWith(`${next}${ANNOUNCE}`), again.stdout);
  assert.equal(fs.readFileSync(config, "utf-8"), entry);

  // A state the setup cannot read promises nothing; the next step reports it instead.
  const flow = `mcp_servers: {${SERVER}: {command: npx}}\n`;
  fs.writeFileSync(config, flow);
  const unread = await linkStep();
  assert.equal(unread.status, 0, unread.stdout + unread.stderr);
  assert.ok(unread.stdout.endsWith(next), unread.stdout);
  assert.deepEqual(box.calls(), [["hermes", "config", "path"], ["hermes", "config", "path"], ["hermes", "config", "path"]]);
});

test("a missing or empty SOUL.md stops the Hermes setup before a link, so Hermes Agent keeps its identity", async (t) => {
  const mock = await startMock(t);
  const { box, soul, env } = hermesBox(t);
  const stopped = [
    `Ragionex Memory is not ready for Hermes Agent: ${soul} is missing or empty. Hermes Agent takes its identity from this file, so the setup does not put the Ragionex Memory rule there alone.`,
    "Next step: write the identity Hermes Agent should have into that file, then run this again (AI agents: ask the user what it should say):",
    `  ${COMMAND} install --agent-mode --agent hermes`,
    "",
  ].join("\n");
  fs.rmSync(soul);
  const missing = await box.run(["install", "--agent", "hermes"], { RAGIONEX_API_BASE: mock.base, ...env });
  assert.equal(missing.status, 1, missing.stdout + missing.stderr);
  assert.equal(missing.stdout, stopped);
  assert.equal(fs.existsSync(soul), false);
  fs.writeFileSync(soul, " \n\n");
  const empty = await box.run(["install", "--agent", "hermes"], { RAGIONEX_API_BASE: mock.base, ...env });
  assert.equal(empty.status, 1, empty.stdout + empty.stderr);
  assert.equal(empty.stdout, stopped);
  assert.equal(fs.readFileSync(soul, "utf-8"), " \n\n");
  assert.deepEqual(mock.state.requests, []);
  assert.deepEqual(box.calls(), [["hermes", "config", "path"], ["hermes", "config", "path"]]);
});

test("without HERMES_HOME the setup follows the profile Hermes Agent reports and leaves the default home alone", async (t) => {
  const mock = await startMock(t);
  const box = machine(t, { clis: ["hermes"], folders: [] });
  const root = process.platform === "win32" ? path.join(box.home, "AppData", "Local", "hermes") : path.join(box.home, ".hermes");
  const profile = path.join(root, "profiles", "work");
  const profileSoul = path.join(profile, "SOUL.md");
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(root, "SOUL.md"), IDENTITY);
  fs.writeFileSync(path.join(root, "active_profile"), "work\n");
  fs.writeFileSync(profileSoul, "You are the work assistant.\n");
  const waits = recordWaits(box);
  const result = await box.run(["install", "--agent", "hermes", ...SETUP], { RAGIONEX_API_BASE: mock.base, ...waits });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const saved = fs.readFileSync(path.join(profile, "config.yaml"), "utf-8");
  assert.ok(saved.includes(`RAGIONEX_MEMORY_INSTRUCTIONS_FILE: '${profileSoul}'`), saved);
  assert.ok(hasRule(profileSoul));
  assert.equal(fs.readFileSync(path.join(root, "SOUL.md"), "utf-8"), IDENTITY);
  assert.equal(fs.existsSync(path.join(root, "config.yaml")), false);
  const removed = await box.run(["uninstall", "--agent", "hermes"], waits);
  assert.equal(removed.status, 0, removed.stdout + removed.stderr);
  assert.equal(fs.readFileSync(profileSoul, "utf-8"), "You are the work assistant.\n");
  assert.equal(fs.readFileSync(path.join(profile, "config.yaml"), "utf-8").includes(SERVER), false);
  assert.equal(fs.readFileSync(path.join(root, "SOUL.md"), "utf-8"), IDENTITY);
});

test("an unsaved Hermes entry is reported from the settings, and the setup never answers yes", async (t) => {
  const mock = await startMock(t);
  const { box, soul, config, env } = hermesBox(t);
  fs.writeFileSync(config, "model: test-model\n");
  const result = await box.run(["install", "--agent", "hermes", ...SETUP], { RAGIONEX_API_BASE: mock.base, ...env, STUB_HERMES_PROBE: "fail" });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^Hermes Agent could not be connected: Ragionex Memory could not be added to its MCP settings\.\nDetails: the Ragionex entry was not found in [^\n]*config\.yaml afterwards\. Its settings were not changed\. The new key "Hermes Agent \(set up \d{4}-\d{2}-\d{2}\)" \(#1\) is not needed;/);
  assert.match(result.stdout, /install --agent-mode --agent hermes --manual\n/);
  assert.deepEqual(inputs(box), ["\n"]);
  assert.equal(fs.readFileSync(config, "utf-8"), "model: test-model\n");
  assert.equal(fs.readFileSync(soul, "utf-8"), IDENTITY);
  assert.deepEqual(fs.readdirSync(path.dirname(config)).filter((name) => name.includes("ragionex-backup")), []);
});

test("only a key of the top-level mcp_servers map counts as the Hermes entry, and a layout the setup cannot read stops it", async (t) => {
  const mock = await startMock(t);
  const { box, config, env } = hermesBox(t);
  const others = [
    "# mcp_servers:",
    `#   ${SERVER}:`,
    "model:",
    `  ${SERVER}: not a server`,
    "mcp_servers:",
    `  # ${SERVER}: switched off`,
    `  ${SERVER}-old:`,
    "    command: old-server",
    "  other:",
    "    env:",
    `      ${SERVER}: x`,
    "",
  ].join("\n");
  fs.writeFileSync(config, others);
  const added = await box.run(["install", "--agent", "hermes", ...SETUP], { RAGIONEX_API_BASE: mock.base, ...env });
  assert.equal(added.status, 0, added.stdout + added.stderr);
  assert.deepEqual(box.calls().map((call) => call.slice(0, 3)), [["hermes", "config", "path"], ["hermes", "mcp", "add"]]);
  const saved = fs.readFileSync(config, "utf-8");
  for (const line of others.split("\n")) assert.ok(saved.includes(line), line);

  const flow = `mcp_servers: {${SERVER}: {command: npx}}\n`;
  fs.writeFileSync(config, flow);
  const refused = await box.run(["install", "--agent", "hermes", ...SETUP], { RAGIONEX_API_BASE: mock.base, ...env });
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stdout, /Details: the Ragionex entry in [^\n]*config\.yaml could not be read \(mcp_servers is not written as a block\)\./);
  assert.equal(fs.readFileSync(config, "utf-8"), flow);
  assert.deepEqual(box.calls().slice(2), [["hermes", "config", "path"]]);
});

test("without the hermes command, uninstall changes nothing, because only Hermes Agent knows its active profile", async (t) => {
  const { box, soul, env } = hermesBox(t, []);
  fs.writeFileSync(soul, ruled("body"));
  const result = await box.run(["uninstall", "--agent", "hermes"], env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^Hermes Agent: `hermes` is not on your PATH, so nothing was changed\. Run this again in a terminal where `hermes` works\.\n/);
  assert.equal(fs.readFileSync(soul, "utf-8"), ruled("body"));
});
