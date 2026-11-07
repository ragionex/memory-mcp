import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { AGENT_CLI_STUB, ENTRY, LINK, SETUP, apiKey, connect, machine, startMock, tempDir, text } from "./helpers.js";

const SERVER = "ragionex-memory-mcp";
const COMMAND = `${process.platform === "win32" ? "npx.cmd" : "npx"} -y @ragionex/memory-mcp@latest`;
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf-8"));
const claudeEnv = (home) => readJson(path.join(home, ".claude.json")).mcpServers[SERVER].env;
const hasRule = (file) => fs.existsSync(file) && fs.readFileSync(file, "utf-8").includes("priority-rule:begin");
const setupRequests = (mock) => mock.state.requests.filter((request) => request.url.startsWith("/v1/setup/"));
const LINK_URL = new RegExp(`http://127\\.0\\.0\\.1:\\d+/connect#${LINK}`);
// The end of a run without a terminal that connected Claude Code.
const READY = [
  "AI agents: the setup just added the Ragionex Memory rule to your global instructions file, so it may now appear in this conversation. It is already in place and takes effect in the new session.",
  "",
  "Ragionex Memory is ready: Claude Code is connected.",
  "",
  "Quit Claude Code completely and open it again in a new session, so Ragionex Memory loads. From then on it works on its own.",
  "",
].join("\n");

// A manual entry in a format the setup cannot parse; only the two placeholders may change.
const PLACEHOLDER_ENTRY = [
  "mcp_servers:",
  "  ragionex-memory-mcp:",
  "    command: npx",
  "    env:",
  '      RAGIONEX_MEMORY_API_KEY: "SETUP_FILLS_KEY"',
  '      RAGIONEX_MEMORY_INSTRUCTIONS_FILE: "SETUP_FILLS_PATH"',
  "",
].join("\n");

test("on Windows the printed setup commands start with npx.cmd, and the server entry keeps cmd /c npx", async (t) => {
  const mock = await startMock(t);
  const box = machine(t, { clis: [], folders: [] });
  // As in the Node.js version test, a preload makes the child process report another runtime: Windows.
  const preload = path.join(box.root, "windows.cjs");
  fs.writeFileSync(preload, 'Object.defineProperty(process, "platform", { value: "win32" });\n');
  const env = { RAGIONEX_API_BASE: mock.base, NODE_OPTIONS: `--require "${preload.replace(/\\/g, "/")}"` };
  const windows = "npx.cmd -y @ragionex/memory-mcp@latest";

  const help = await box.run(["--help"], env);
  assert.equal(help.status, 0, help.stderr);
  assert.ok(help.stdout.includes(`  ${windows} install [flags]\n`), help.stdout);

  const rules = path.join(box.home, "AGENTS.md");
  const settings = path.join(box.home, "config.yaml");
  fs.writeFileSync(settings, PLACEHOLDER_ENTRY);
  const shown = await box.run(["install", "--agent-mode", "--manual", "--instructions-file", rules, "--mcp-config", settings], env);
  assert.equal(shown.status, 0, shown.stderr);
  assert.ok(shown.stdout.includes(`\n  ${windows} install --agent-mode --manual `), shown.stdout);
  assert.ok(shown.stdout.endsWith(` --link ${LINK} --code <code>\n`), shown.stdout);
  assert.doesNotMatch(help.stdout + shown.stdout, /\bnpx -y /);

  const entry = await box.run(["install", "--manual"], env);
  assert.ok(entry.stdout.includes('"args": ["/c", "npx", "-y", "@ragionex/memory-mcp@latest"]'), entry.stdout);

  const client = await connect(t, { home: box.home, base: mock.base, name: "codex-mcp-client", nodeArgs: ["-r", preload] });
  const result = await client.callTool({ name: "ragionex_recall_memory", arguments: { query: "Which editor does the user prefer?" } });
  assert.ok(text(result).includes(`Run the setup: ${windows} install --agent codex`), text(result));
});

test("a run without a terminal prints the menu with its flags, then the link, then connects with the code", async (t) => {
  const mock = await startMock(t);
  // Browser openers on PATH and a display: a run without a terminal still opens nothing.
  const box = machine(t, { clis: ["claude", "codex", "opencode", "xdg-open", "open"] });
  const env = { RAGIONEX_API_BASE: mock.base, DISPLAY: ":0" };
  const first = await box.run(["install"], env);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, [
    "Which agent should get Ragionex Memory?",
    "  1) Claude Code (found)",
    "  2) Codex",
    "  3) OpenCode",
    "  4) Hermes Agent",
    "  5) My agent is not in the list (manual setup)",
    "",
    "AI agents: run this again with your own agent code (claude-code, codex, opencode, hermes), or with --manual if you are not in the list:",
    `  ${COMMAND} install --agent-mode --agent <code>`,
    "",
  ].join("\n"));
  assert.deepEqual(mock.state.requests, []);
  assert.deepEqual(box.calls(), []);

  const second = await box.run(["install", "--agent", "claude-code"], env);
  assert.equal(second.status, 0, second.stderr);
  const url = second.stdout.match(LINK_URL)?.[0];
  assert.ok(url, second.stdout);
  assert.equal(second.stdout, [
    "",
    "Open this link to connect Claude Code to Ragionex Memory:",
    "",
    `  ${url}`,
    "",
    "Sign in there. No account yet? One is created for free.",
    "Then copy the one-time code on that page and paste it here.",
    "",
    "AI agents: give the user this link to open in their own browser, and never open it yourself.",
    "When the user pastes the one-time code from that page, run this yourself with it; there is no need to show it to the user:",
    `  ${COMMAND} install --agent-mode --agent claude-code --link ${LINK} --code <code>`,
    "",
  ].join("\n"));
  const [asked] = setupRequests(mock);
  assert.equal(asked.url, "/v1/setup/connect");
  assert.deepEqual(asked.body, {});
  assert.deepEqual(box.calls(), []);
  assert.equal(hasRule(path.join(box.home, ".claude", "CLAUDE.md")), false);

  // Project-scope mentions of the server are not a user-scope registration.
  fs.writeFileSync(path.join(box.home, ".claude.json"), JSON.stringify({ projects: { "/work": { allowedTools: [`mcp__${SERVER}__ragionex_save_memory`] } } }));
  const third = await box.run(["install", "--agent", "claude-code", ...SETUP], env);
  assert.equal(third.status, 0, third.stdout + third.stderr);
  assert.equal(third.stdout, READY);
  const [key] = mock.state.issued;
  assert.equal(claudeEnv(box.home).RAGIONEX_MEMORY_API_KEY, key);
  assert.equal(third.stdout.includes(key) || third.stderr.includes(key), false);
  assert.deepEqual(box.calls().map((call) => call[2]), ["add"]);
  assert.ok(hasRule(path.join(box.home, ".claude", "CLAUDE.md")));
  const redeem = setupRequests(mock).find((request) => request.url === "/v1/setup/connect/redeem");
  assert.deepEqual(Object.keys(redeem.body), ["link", "code", "key"]);
  assert.deepEqual([redeem.body.link, redeem.body.code], [LINK, "K7QFM2XR"]);
  assert.match(redeem.body.key.name, /^Claude Code \(set up \d{4}-\d{2}-\d{2}\)$/);
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
  assert.deepEqual(setupRequests(mock).map((request) => request.url), ["/v1/setup/connect/redeem", "/v1/setup/connect/redeem"]);
  assert.deepEqual(box.calls().map((call) => call[2]), ["remove", "add", "remove", "add"]);
  assert.deepEqual(fs.readdirSync(box.home).filter((name) => name.includes("ragionex-backup")), []);
});

test("a wrong code asks for the code again on the same link, and a spent or cut link asks for a new one", async (t) => {
  const mock = await startMock(t);
  const box = machine(t);
  const env = { RAGIONEX_API_BASE: mock.base };
  const again = [
    "That code is not correct. Copy the code from the page again and paste it here.",
    "AI agents: when the user pastes the code again, run this yourself with it:",
    `  ${COMMAND} install --agent-mode --agent claude-code --link ${LINK} --code <code>`,
    "",
  ].join("\n");
  const wrong = await box.run(["install", "--agent", "claude-code", "--link", LINK, "--code", "AAAA-BBBB"], env);
  assert.equal(wrong.status, 0, wrong.stdout + wrong.stderr);
  assert.equal(wrong.stdout, again);
  // A code that cannot be one is answered the same way without asking the service.
  const malformed = await box.run(["install", "--agent", "claude-code", "--link", LINK, "--code", "12"], env);
  assert.equal(malformed.status, 0, malformed.stdout + malformed.stderr);
  assert.equal(malformed.stdout, again);
  assert.deepEqual(setupRequests(mock).map((request) => [request.url, request.body.code]), [["/v1/setup/connect/redeem", "AAAABBBB"]]);
  const newLink = [
    "This link has expired or can no longer be used. Run the setup again for a new link.",
    `  ${COMMAND} install --agent-mode --agent claude-code`,
    "AI agents: run that command yourself for a new link, then give the new link to the user.",
    "",
  ].join("\n");
  // A cut link is answered without asking the service; a spent one by the service.
  const cut = await box.run(["install", "--agent", "claude-code", "--link", LINK.slice(0, 20), "--code", "K7QF-M2XR"], env);
  assert.equal(cut.status, 0, cut.stdout + cut.stderr);
  assert.equal(cut.stdout, newLink);
  assert.equal(setupRequests(mock).length, 1);
  const spent = await box.run(["install", "--agent", "claude-code", "--link", "Z".repeat(24), "--code", "K7QF-M2XR"], env);
  assert.equal(spent.status, 0, spent.stdout + spent.stderr);
  assert.equal(spent.stdout, newLink);
  assert.deepEqual(setupRequests(mock).map((request) => request.body.link), [LINK, "Z".repeat(24)]);
  assert.deepEqual(box.calls(), []);
  assert.equal(hasRule(path.join(box.home, ".claude", "CLAUDE.md")), false);
  assert.deepEqual(mock.state.issued, []);
});

test("the account key limit and an unusable account name their own next step", async (t) => {
  const mock = await startMock(t);
  const box = machine(t);
  const env = { RAGIONEX_API_BASE: mock.base };
  mock.state.replies.redeem.push({ status: 409, body: { success: false, error: "Key limit reached.", code: "key_limit_reached" } });
  const capped = await box.run(["install", "--agent", "claude-code", ...SETUP], env);
  assert.equal(capped.status, 1);
  assert.match(capped.stdout, /as many active API keys as it can have/);
  assert.match(capped.stdout, new RegExp(`install --agent-mode --agent claude-code --link ${LINK} --code K7QFM2XR\\n`));
  mock.state.replies.redeem.push({ status: 403, body: { success: false, error: "This account is unavailable.", code: "account_unavailable" } });
  const unavailable = await box.run(["install", "--agent", "claude-code", ...SETUP], env);
  assert.equal(unavailable.status, 1);
  assert.match(unavailable.stdout, /the Ragionex account you signed in with cannot be used/);
  assert.match(unavailable.stdout, /contact@ragionex\.com/);
  assert.deepEqual(box.calls(), []);
  assert.deepEqual(mock.state.issued, []);
});

test("a network limit on the link or the code names the wait and the command to run again", async (t) => {
  const mock = await startMock(t);
  const box = machine(t);
  const env = { RAGIONEX_API_BASE: mock.base };
  const limited = (seconds) => ({ status: 429, body: { success: false, error: "Rate limit exceeded", code: "rate_limited", retry_after_seconds: seconds } });
  mock.state.replies.connect.push(limited(3000));
  const link = await box.run(["install", "--agent", "claude-code"], env);
  assert.equal(link.status, 1, link.stdout + link.stderr);
  assert.equal(link.stdout, [
    "Ragionex Memory is not ready: too many setup requests came from this network.",
    "Next step: wait 50 minutes, then run this again (AI agents: tell the user now; do not wait yourself):",
    `  ${COMMAND} install --agent-mode --agent claude-code`,
    "",
  ].join("\n"));
  mock.state.replies.redeem.push(limited(60));
  const code = await box.run(["install", "--agent", "claude-code", ...SETUP], env);
  assert.equal(code.status, 1, code.stdout + code.stderr);
  assert.equal(code.stdout, [
    "Ragionex Memory is not ready: too many setup requests came from this network.",
    "Next step: wait 1 minute, then run this again (AI agents: tell the user now; do not wait yourself):",
    `  ${COMMAND} install --agent-mode --agent claude-code --link ${LINK} --code K7QFM2XR`,
    "",
  ].join("\n"));
  assert.deepEqual(box.calls(), []);
  assert.deepEqual(mock.state.issued, []);
});

test("an unreachable service changes nothing and says what to do", async (t) => {
  const box = machine(t);
  const result = await box.run(["install", "--agent", "claude-code"]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /is not ready: Ragionex could not be reached/);
  assert.match(result.stdout, /install --agent-mode --agent claude-code\n/);
  assert.deepEqual(box.calls(), []);
});

test("--link and --code are only used together", async (t) => {
  const mock = await startMock(t);
  const box = machine(t);
  for (const pair of [["--link", LINK], ["--code", "K7QF-M2XR"]]) {
    const result = await box.run(["install", "--agent", "claude-code", ...pair], { RAGIONEX_API_BASE: mock.base });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--link and --code are used together/);
  }
  assert.deepEqual(mock.state.requests, []);
});

test("only the bare --agent-mode flag counts", async (t) => {
  const box = machine(t, { clis: [] });
  const valued = await box.run(["install", "--agent-mode=yes"]);
  assert.equal(valued.status, 2);
  assert.match(valued.stderr, /^Unknown argument: --agent-mode=yes\n/);
});

test("a listed agent that is not found stops before a link is made and points to manual setup", async (t) => {
  const mock = await startMock(t);
  const box = machine(t, { clis: [], folders: [".codex"] });
  const result = await box.run(["install", "--agent", "codex"], { RAGIONEX_API_BASE: mock.base });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Codex could not be connected: it was not found/);
  assert.match(result.stdout, /install --agent-mode --agent codex --manual\n/);
  assert.match(result.stdout, /tell us so we can fix it/);
  assert.deepEqual(mock.state.requests, []);
});

test("a failed registration names its unused key, points to manual setup and never shows the key", async (t) => {
  const mock = await startMock(t);
  const box = machine(t);
  fs.writeFileSync(path.join(box.home, ".claude.json"), "{}");
  const result = await box.run(["install", "--agent", "claude-code", ...SETUP], { RAGIONEX_API_BASE: mock.base, STUB_FAIL: "claude mcp add" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Claude Code could not be connected: Ragionex Memory could not be added/);
  assert.match(result.stdout, /simulated failure\)\. Its settings were not changed/);
  assert.match(result.stdout, /"Claude Code \(set up \d{4}-\d{2}-\d{2}\)" \(#1\) is not needed/);
  assert.match(result.stdout, /install --agent-mode --agent claude-code --manual\n/);
  assert.match(result.stdout, /rgx_memory_\*\*\*/);
  const [key] = mock.state.issued;
  assert.equal(result.stdout.includes(key) || result.stderr.includes(key), false);
  assert.deepEqual(setupRequests(mock).map((request) => request.url), ["/v1/setup/connect/redeem"]);
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

test("with no Claude Code to run, the setup stops before a link is made and points to manual setup", async (t) => {
  const mock = await startMock(t);
  const box = machine(t, { clis: [] });
  const result = await box.run(["install", "--agent", "claude-code"], { RAGIONEX_API_BASE: mock.base });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Claude Code could not be connected: it was not found/);
  assert.match(result.stdout, /install --agent-mode --agent claude-code --manual\n/);
  assert.deepEqual(mock.state.requests, []);
});

test("the connection check reports the connection only, also for an empty Vault", async (t) => {
  const mock = await startMock(t);
  const home = tempDir(t);
  const client = await connect(t, { home, base: mock.base, key: apiKey("a"), name: "claude-code" });
  const result = await client.callTool({ name: "ragionex_memory_connection", arguments: {} });
  assert.equal(result.content.length, 1);
  assert.ok(!mock.state.requests.some((request) => request.url.startsWith("/v1/memory/list")));
});

// A real terminal comes from Python's pty module. The probe also proves that a pseudo-terminal
// opens here and returns the interpreter's absolute path, because the installer's PATH holds
// only the stub agent CLIs.
const probe = process.platform === "win32"
  ? null
  : spawnSync("python3", ["-c", "import os, pty, sys; os.waitstatus_to_exitcode; master, slave = os.openpty(); os.close(master); os.close(slave); print(sys.executable)"], { encoding: "utf-8", timeout: 10_000 });
const PYTHON = probe?.status === 0 ? probe.stdout.trim() : "";
const NO_TERMINAL = process.platform === "win32"
  ? "Windows offers no pseudo-terminal to this test"
  : PYTHON === "" ? "this machine has no python3 that can open a pseudo-terminal" : false;

// Runs the installer in a pseudo-terminal and types each answer only once its prompt is on
// screen; an answer given as a function runs first, so a test can change files between prompts.
// A run that stops answering is killed, so the test fails instead of hanging. The code prompt
// is matched by "the code here: ", which both of its forms end with.
async function terminalInstall(box, mock, answers, args = ["install", "--agent", "claude-code"], env = {}) {
  const pending = [...answers];
  const child = spawn(PYTHON, [
    "-c", "import os, pty, sys; sys.exit(os.waitstatus_to_exitcode(pty.spawn(sys.argv[1:])))",
    process.execPath, ENTRY, ...args,
  ], {
    cwd: box.root,
    env: { HOME: box.home, PATH: box.bin, RAGIONEX_API_BASE: mock.base, ...env },
    stdio: ["pipe", "pipe", "inherit"],
    timeout: 30_000,
    killSignal: "SIGKILL",
  });
  let output = "";
  let seen = 0;
  child.stdout.setEncoding("utf-8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
    while (pending.length) {
      const at = output.indexOf(pending[0][0], seen);
      if (at < 0) break;
      seen = at + pending[0][0].length;
      const [, answer] = pending.shift(); child.stdin.write(typeof answer === "function" ? answer() : answer);
    }
  });
  const [status] = await once(child, "close");
  return { status, output, unanswered: pending.map(([prompt]) => prompt) };
}

// A terminal run opens with the one line for AI agents, above everything else, and prints no other.
function opensWithAgentLine(output, command = "install") {
  const shown = output.replace(/\r\n/g, "\n");
  assert.ok(shown.startsWith(`AI agents: this setup is interactive and waits for your input, so it will not work for you.\nStop it and run it again with --agent-mode, so you can use it:\n  ${COMMAND} ${command} --agent-mode\n\n`), output);
  assert.equal(shown.split("AI agents:").length, 2, output);
}

test("a terminal run opens with the line for agents, shows the link, asks again after a wrong code and connects", { skip: NO_TERMINAL }, async (t) => {
  const mock = await startMock(t);
  const box = machine(t);
  const result = await terminalInstall(box, mock, [
    ["the code here: ", "AAAA-BBBB\r"],
    ["the code here: ", "k7qf m2xr\r"],
  ]);
  assert.deepEqual(result.unanswered, [], result.output);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Open this link to connect Claude Code to Ragionex Memory:/);
  assert.match(result.output, LINK_URL);
  assert.match(result.output, /That code is not correct\. Copy the code from the page again and paste it here\./);
  assert.match(result.output, /Ragionex Memory is ready: Claude Code is connected\./);
  opensWithAgentLine(result.output);
  assert.deepEqual(setupRequests(mock).map((request) => [request.url, request.body.code ?? null]), [
    ["/v1/setup/connect", null],
    ["/v1/setup/connect/redeem", "AAAABBBB"],
    ["/v1/setup/connect/redeem", "K7QFM2XR"],
  ]);
  assert.equal(claudeEnv(box.home).RAGIONEX_MEMORY_API_KEY, mock.state.issued[0]);
  assert.ok(hasRule(path.join(box.home, ".claude", "CLAUDE.md")));
});

test("an empty answer at the code prompt asks again and sends nothing", { skip: NO_TERMINAL }, async (t) => {
  const mock = await startMock(t);
  const box = machine(t);
  const result = await terminalInstall(box, mock, [
    ["the code here: ", "\r"],
    ["Paste the code here: ", "\r"],
    ["Paste the code here: ", "K7QF-M2XR\r"],
  ]);
  assert.deepEqual(result.unanswered, [], result.output);
  assert.equal(result.status, 0, result.output);
  assert.doesNotMatch(result.output, /Setup was cancelled/);
  assert.deepEqual(setupRequests(mock).map((request) => request.url), ["/v1/setup/connect", "/v1/setup/connect/redeem"]);
});

test("a spent link stops a terminal run with the command for a new link", { skip: NO_TERMINAL }, async (t) => {
  const mock = await startMock(t);
  const box = machine(t);
  mock.state.replies.redeem.push({ status: 410, body: { success: false, error: "This link has expired or can no longer be used.", code: "link_expired" } });
  const result = await terminalInstall(box, mock, [["the code here: ", "K7QF-M2XR\r"]]);
  assert.deepEqual(result.unanswered, [], result.output);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /This link has expired or can no longer be used\. Run the setup again for a new link\.\r?\n  npx -y @ragionex\/memory-mcp@latest install --agent claude-code\r?\n/);
  opensWithAgentLine(result.output);
  // The run asked for the code once and stopped.
  assert.equal(result.output.split("the code here: ").length, 2);
  assert.deepEqual(box.calls(), []);
});

test("cancelling a terminal run at the code prompt registers and writes nothing", { skip: NO_TERMINAL }, async (t) => {
  const mock = await startMock(t);
  const box = machine(t);
  const result = await terminalInstall(box, mock, [
    // Ctrl-C at the code prompt.
    ["the code here: ", "\u0003"],
  ]);
  assert.deepEqual(result.unanswered, [], result.output);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /Setup was cancelled\./);
  assert.deepEqual(setupRequests(mock).map((request) => request.url), ["/v1/setup/connect"]);
  assert.deepEqual(box.calls(), []);
  assert.equal(hasRule(path.join(box.home, ".claude", "CLAUDE.md")), false);
});

test("a terminal with a display offers to open the link and falls back to the printed link", { skip: NO_TERMINAL }, async (t) => {
  const mock = await startMock(t);
  const box = machine(t);
  // The stub PATH has no browser opener, so starting one fails as it would without a browser.
  const result = await terminalInstall(box, mock, [
    ["Press Enter to open the link in your browser, or paste the code here: ", "\r"],
    ["Paste the code here: ", "K7QF-M2XR\r"],
  ], ["install", "--agent", "claude-code"], { DISPLAY: ":0" });
  assert.deepEqual(result.unanswered, [], result.output);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Could not open a browser here\. Open the link above on any device\./);
});

test("a terminal run without an agent code preselects the one agent found and connects it", { skip: NO_TERMINAL }, async (t) => {
  const mock = await startMock(t);
  const box = machine(t);
  const result = await terminalInstall(box, mock, [
    ["Which one? [1-5, Enter = 1] ", "\r"],
    ["the code here: ", "K7QF-M2XR\r"],
  ], ["install"]);
  assert.deepEqual(result.unanswered, [], result.output);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Which agent should get Ragionex Memory\?/);
  assert.match(result.output, /1\) Claude Code \(found\)/);
  assert.doesNotMatch(result.output, /Codex \(found\)/);
  assert.match(result.output, /5\) My agent is not in the list \(manual setup\)/);
  opensWithAgentLine(result.output);
  assert.equal(claudeEnv(box.home).RAGIONEX_MEMORY_API_KEY, mock.state.issued[0]);
});

test("several agents found are all marked and none is preselected", { skip: NO_TERMINAL }, async (t) => {
  const mock = await startMock(t);
  const box = machine(t, { folders: [".claude", ".codex"] });
  const result = await terminalInstall(box, mock, [
    ["Which one? [1-5] ", "2\r"],
    ["the code here: ", "K7QF-M2XR\r"],
  ], ["install"]);
  assert.deepEqual(result.unanswered, [], result.output);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /1\) Claude Code \(found\)/);
  assert.match(result.output, /2\) Codex \(found\)/);
  assert.match(setupRequests(mock).find((request) => request.url === "/v1/setup/connect/redeem").body.key.name, /^Codex \(set up /);
});

test("the agent menu can be cancelled", { skip: NO_TERMINAL }, async (t) => {
  const mock = await startMock(t);
  const box = machine(t);
  const result = await terminalInstall(box, mock, [["Which one? [1-5, Enter = 1] ", "\x04"]], ["install"]);
  assert.deepEqual(result.unanswered, [], result.output);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /Setup was cancelled\./);
  assert.doesNotMatch(result.output, /Invalid choice/);
  assert.deepEqual(mock.state.requests, []);
});

test("agent mode in a terminal prints what a run without a terminal prints, waits for nothing and opens no browser", { skip: NO_TERMINAL }, async (t) => {
  const mock = await startMock(t);
  // Browser openers on PATH and a display: agent mode still opens nothing.
  const box = machine(t, { clis: ["claude", "codex", "opencode", "xdg-open", "open"] });
  const env = { DISPLAY: ":0" };
  for (const args of [
    ["install"],
    ["install", "--agent", "claude-code"],
    ["install", "--manual"],
    ["install", "--agent", "claude-code", ...SETUP],
  ]) {
    const plain = await box.run(args, { RAGIONEX_API_BASE: mock.base, ...env });
    assert.equal(plain.status, 0, plain.stdout + plain.stderr);
    // The flag counts wherever it stands; a run that waited would be killed instead of ending with 0.
    const terminal = await terminalInstall(box, mock, [], [...args, "--agent-mode"], env);
    assert.equal(terminal.status, 0, terminal.output);
    assert.ok(terminal.output.replace(/\r\n/g, "\n").endsWith(plain.stdout), terminal.output);
    assert.doesNotMatch(terminal.output, /waits for your input/);
  }
  assert.deepEqual(box.calls().filter(([cli]) => cli === "xdg-open" || cli === "open"), []);
});

test("uninstall honours agent mode in a terminal, and a terminal uninstall opens with the line for agents", { skip: NO_TERMINAL }, async (t) => {
  const mock = await startMock(t);
  const box = machine(t, { clis: [] });
  for (const args of [["uninstall"], ["uninstall", "--manual"]]) {
    const plain = await box.run(args);
    assert.equal(plain.status, 0, plain.stdout + plain.stderr);
    const terminal = await terminalInstall(box, mock, [], [...args, "--agent-mode"]);
    assert.equal(terminal.status, 0, terminal.output);
    assert.ok(terminal.output.replace(/\r\n/g, "\n").endsWith(plain.stdout), terminal.output);
    assert.doesNotMatch(terminal.output, /waits for your input/);
  }
  const menu = await terminalInstall(box, mock, [["Which one? [1-5] ", "\x04"]], ["uninstall"]);
  assert.deepEqual(menu.unanswered, [], menu.output);
  assert.equal(menu.status, 1, menu.output);
  opensWithAgentLine(menu.output, "uninstall");
  assert.match(menu.output, /Uninstall was cancelled\./);
});

test("manual setup shows the entry and both file questions, checks the entry before a link and fills only its placeholders", async (t) => {
  const mock = await startMock(t);
  const box = machine(t);
  const env = { RAGIONEX_API_BASE: mock.base };
  // A folder with a space proves printed commands keep each path one argument.
  const folder = path.join(box.home, "my agent");
  fs.mkdirSync(folder);
  const rules = path.join(folder, "AGENTS.md");
  const settings = path.join(folder, "config.yaml");
  const files = ["--instructions-file", rules, "--mcp-config", settings];

  const steps = await box.run(["install", "--manual"], env);
  assert.equal(steps.status, 0, steps.stderr);
  assert.match(steps.stdout, /^Add this entry to your agent's global MCP settings file, in the format that file uses:/);
  assert.match(steps.stdout, /"RAGIONEX_MEMORY_INSTRUCTIONS_FILE": "SETUP_FILLS_PATH"/);
  assert.match(steps.stdout, /\nFull path of your agent's global instructions file\nExample: \S+AGENTS\.md\n\nFull path of your agent's global MCP settings file\nExample: \S+mcp\.json\n/);
  assert.ok(steps.stdout.endsWith([
    "AI agents: add the entry to your own MCP settings file (ask the user only if you cannot edit it), then run this with the full paths of both files:",
    `  ${COMMAND} install --agent-mode --manual --instructions-file <global instructions file> --mcp-config <MCP settings file>`,
    "",
  ].join("\n")), steps.stdout);
  assert.deepEqual(mock.state.requests, []);
  const coded = await box.run(["install", "--agent", "manual"], env);
  assert.equal(coded.stdout, steps.stdout, coded.stderr);

  const missing = await box.run(["install", "--manual", ...files], env);
  assert.equal(missing.status, 0, missing.stderr);
  assert.match(missing.stdout, /^Add this entry to your agent's global MCP settings file/);
  assert.match(missing.stdout, new RegExp(String.raw`\nSETUP_FILLS_KEY and SETUP_FILLS_PATH were not found in [^\n]*config\.yaml\. Add the entry above to that file\.\nAI agents: do this yourself \(ask the user only if you cannot edit that file\), then run this again:\n  npx${process.platform === "win32" ? String.raw`\.cmd` : ""} [^\n]*--instructions-file "[^"]*my agent[^"]*AGENTS\.md" --mcp-config "[^"]*config\.yaml"\n$`));
  assert.equal(missing.stdout.includes("Full path of"), false);
  assert.deepEqual(mock.state.requests, []);

  fs.writeFileSync(settings, PLACEHOLDER_ENTRY);
  const shown = await box.run(["install", "--manual", ...files], env);
  assert.equal(shown.status, 0, shown.stdout + shown.stderr);
  assert.equal(shown.stdout.includes("Add this entry"), false);
  assert.match(shown.stdout, /Open this link to connect your agent to Ragionex Memory:/);
  assert.match(shown.stdout, new RegExp(`config\\.yaml" --link ${LINK} --code <code>\\n$`));
  assert.deepEqual(setupRequests(mock).map((request) => [request.url, request.body]), [["/v1/setup/connect", {}]]);

  const done = await box.run(["install", "--manual", ...SETUP, ...files], env);
  assert.equal(done.status, 0, done.stdout + done.stderr);
  assert.equal(done.stdout.includes("Add this entry"), false);
  assert.match(done.stdout, /Ragionex Memory is ready: your agent is connected\./);
  const [key] = mock.state.issued;
  const filled = process.platform === "win32" ? rules.replace(/\\/g, "/") : rules;
  assert.equal(fs.readFileSync(settings, "utf-8"), PLACEHOLDER_ENTRY.replace("SETUP_FILLS_KEY", key).replace("SETUP_FILLS_PATH", filled));
  assert.equal(done.stdout.includes(key) || done.stderr.includes(key), false);
  assert.ok(hasRule(rules));
  const redeem = setupRequests(mock).find((request) => request.url === "/v1/setup/connect/redeem");
  assert.match(redeem.body.key.name, /^Custom agent \(set up \d{4}-\d{2}-\d{2}\)$/);
  assert.ok(mock.state.requests.some((request) => request.url === "/v1/memory/identity" && request.headers["x-api-key"] === key));
  assert.deepEqual(box.calls(), []);
  assert.deepEqual(fs.readdirSync(folder).filter((name) => name.includes("ragionex-backup")), []);
});

test("manual setup as the fallback names the key after the listed agent and runs none of its commands", async (t) => {
  const mock = await startMock(t);
  const box = machine(t, { folders: [path.join(".config", "opencode")] });
  const folder = path.join(box.home, ".config", "opencode");
  const rules = path.join(folder, "AGENTS.md");
  const settings = path.join(folder, "opencode.jsonc");
  const entry = {
    type: "local",
    command: ["npx", "-y", "@ragionex/memory-mcp@latest"],
    environment: { RAGIONEX_MEMORY_API_KEY: "SETUP_FILLS_KEY", RAGIONEX_MEMORY_INSTRUCTIONS_FILE: "SETUP_FILLS_PATH" },
  };
  fs.writeFileSync(settings, JSON.stringify({ mcp: { [SERVER]: entry } }, null, 2));
  const result = await box.run(
    ["install", "--agent", "opencode", "--manual", ...SETUP, "--instructions-file", rules, "--mcp-config", settings],
    { RAGIONEX_API_BASE: mock.base },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Ragionex Memory is ready: OpenCode is connected\./);
  const [key] = mock.state.issued;
  const filled = readJson(settings).mcp[SERVER].environment;
  assert.equal(filled.RAGIONEX_MEMORY_API_KEY, key);
  assert.equal(filled.RAGIONEX_MEMORY_INSTRUCTIONS_FILE, process.platform === "win32" ? rules.replace(/\\/g, "/") : rules);
  assert.ok(hasRule(rules));
  const redeem = setupRequests(mock).find((request) => request.url === "/v1/setup/connect/redeem");
  assert.match(redeem.body.key.name, /^OpenCode \(set up \d{4}-\d{2}-\d{2}\)$/);
  assert.deepEqual(box.calls(), []);
});

test("a manual entry with a repeated placeholder is answered before a link is made", async (t) => {
  const mock = await startMock(t);
  const box = machine(t);
  const settings = path.join(box.home, "config.yaml");
  fs.writeFileSync(settings, PLACEHOLDER_ENTRY + PLACEHOLDER_ENTRY);
  const result = await box.run(
    ["install", "--manual", "--instructions-file", path.join(box.home, "AGENTS.md"), "--mcp-config", settings],
    { RAGIONEX_API_BASE: mock.base },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /appear more than once in [^\n]*config\.yaml\. Keep only one Ragionex entry in that file\.\nAI agents: /);
  assert.deepEqual(mock.state.requests, []);
  assert.equal(fs.readFileSync(settings, "utf-8"), PLACEHOLDER_ENTRY + PLACEHOLDER_ENTRY);
});

test("a path a shell would change is printed as a placeholder", async (t) => {
  const mock = await startMock(t);
  const box = machine(t);
  // Command Prompt expands %NAME% and shells expand ! even inside double quotes.
  const folder = path.join(box.home, "50%x!y");
  fs.mkdirSync(folder);
  const result = await box.run(
    ["install", "--manual", "--instructions-file", path.join(folder, "AGENTS.md"), "--mcp-config", path.join(box.home, "config.yaml")],
    { RAGIONEX_API_BASE: mock.base },
  );
  assert.equal(result.status, 0, result.stderr);
  // The settings path is quoted wherever the temporary folder holds a character such as "~".
  assert.match(result.stdout, /--instructions-file <global instructions file> --mcp-config ("[^"\n]*config\.yaml"|\S*config\.yaml)\n$/);
  assert.deepEqual(mock.state.requests, []);
});

test("a manual setup that stops after the code keeps the placeholders and names the unused key", async (t) => {
  const mock = await startMock(t);
  const box = machine(t);
  const rules = path.join(box.home, "AGENTS.md");
  const settings = path.join(box.home, "config.yaml");
  // A folder where the instructions file should be makes the rule write fail.
  fs.mkdirSync(rules);
  fs.writeFileSync(settings, PLACEHOLDER_ENTRY);
  const result = await box.run(
    ["install", "--manual", ...SETUP, "--instructions-file", rules, "--mcp-config", settings],
    { RAGIONEX_API_BASE: mock.base },
  );
  assert.equal(result.status, 1);
  assert.match(result.stdout, /could not be read/);
  assert.match(result.stdout, /"Custom agent \(set up \d{4}-\d{2}-\d{2}\)" \(#1\) is not needed/);
  assert.match(result.stdout, /--mcp-config \S*config\.yaml"?\n/);
  assert.equal(fs.readFileSync(settings, "utf-8"), PLACEHOLDER_ENTRY);
});

test("a manual setup path that is not a full path counts as not given", async (t) => {
  const mock = await startMock(t);
  const box = machine(t);
  const result = await box.run(
    ["install", "--manual", "--instructions-file", "AGENTS.md", "--mcp-config", "mcp.json"],
    { RAGIONEX_API_BASE: mock.base },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Full path of your agent's global instructions file/);
  assert.deepEqual(mock.state.requests, []);
  assert.equal(fs.existsSync(path.join(box.root, "AGENTS.md")), false);
});

test("a terminal manual setup asks for both files, waits for the entry and fills it", { skip: NO_TERMINAL }, async (t) => {
  const mock = await startMock(t);
  const box = machine(t, { clis: [] });
  const rules = path.join(box.home, "agent", "AGENTS.md");
  const settings = path.join(box.home, "agent", "config.yaml");
  fs.mkdirSync(path.dirname(rules));
  const result = await terminalInstall(box, mock, [
    ["Path: ", `${rules}\r`],
    ["Path: ", `${settings}\r`],
    ["press Enter to check again: ", () => {
      fs.writeFileSync(settings, PLACEHOLDER_ENTRY);
      return "\r";
    }],
    ["the code here: ", "K7QF-M2XR\r"],
  ], ["install", "--manual"]);
  assert.deepEqual(result.unanswered, [], result.output);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Add this entry to your agent's global MCP settings file/);
  assert.match(result.output, /Example: \/(home|Users)\/user\/\.myagent\/AGENTS\.md/);
  assert.match(result.output, /SETUP_FILLS_KEY and SETUP_FILLS_PATH were not found/);
  assert.match(result.output, /Ragionex Memory is ready: your agent is connected\./);
  opensWithAgentLine(result.output);
  const [key] = mock.state.issued;
  assert.equal(fs.readFileSync(settings, "utf-8"), PLACEHOLDER_ENTRY.replace("SETUP_FILLS_KEY", key).replace("SETUP_FILLS_PATH", rules));
  assert.ok(hasRule(rules));
});

test("manual setup refuses one file for both paths before a link is made", async (t) => {
  const mock = await startMock(t);
  const box = machine(t);
  const settings = path.join(box.home, "config.yaml");
  fs.writeFileSync(settings, PLACEHOLDER_ENTRY);
  const result = await box.run(
    ["install", "--manual", "--instructions-file", settings, "--mcp-config", settings],
    { RAGIONEX_API_BASE: mock.base },
  );
  assert.equal(result.status, 1);
  assert.match(result.stdout, /the global instructions file and the MCP settings file are the same file/);
  assert.deepEqual(mock.state.requests, []);
  assert.equal(fs.readFileSync(settings, "utf-8"), PLACEHOLDER_ENTRY);
});

test("a terminal manual setup reads dragged paths and refuses one file for both", { skip: NO_TERMINAL }, async (t) => {
  const mock = await startMock(t);
  const box = machine(t, { clis: [] });
  // A folder with a space, typed the way macOS and Linux terminals paste a dragged file.
  const folder = path.join(box.home, "my agent");
  fs.mkdirSync(folder);
  const rules = path.join(folder, "AGENTS.md");
  fs.writeFileSync(rules, "# Mine\n");
  const result = await terminalInstall(box, mock, [
    ["Path: ", `${rules.replaceAll(" ", "\\ ")}\r`],
    ["Path: ", `'${rules}'\r`],
    ["Path: ", "\x04"],
  ], ["install", "--manual"]);
  assert.deepEqual(result.unanswered, [], result.output);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /That is the same file as the global instructions file\./);
  assert.match(result.output, /Setup was cancelled\./);
  assert.deepEqual(mock.state.requests, []);
  assert.equal(fs.readFileSync(rules, "utf-8"), "# Mine\n");
});

test("manual path preflight refuses a settings flag reused at the instructions prompt", { skip: NO_TERMINAL }, async (t) => {
  const mock = await startMock(t);
  const box = machine(t, { clis: [], folders: [] });
  const settings = path.join(box.home, "config.yaml");
  fs.writeFileSync(settings, PLACEHOLDER_ENTRY);
  const before = fs.readdirSync(box.home).sort();
  const result = await terminalInstall(box, mock, [
    ["Path: ", `${settings}\r`],
  ], ["install", "--manual", "--mcp-config", settings, ...SETUP]);
  assert.deepEqual(result.unanswered, [], result.output);
  assert.deepEqual(mock.state.requests, [], result.output);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /the global instructions file and the MCP settings file are the same file/);
  assert.equal(fs.readFileSync(settings, "utf-8"), PLACEHOLDER_ENTRY);
  assert.deepEqual(fs.readdirSync(box.home).sort(), before);
  assert.deepEqual(box.calls(), []);
});

test("manual path preflight refuses unsafe instructions flags before setup requests or writes", async (t) => {
  const characters = [
    ["double quote", '"'],
    ["line feed", "\n"],
  ];
  if (process.platform !== "win32") characters.push(["backslash", "\\"]);
  for (const [name, character] of characters) {
    await t.test(name, async (t) => {
      const mock = await startMock(t);
      const box = machine(t, { clis: [], folders: [] });
      const rules = path.join(box.home, `AGENTS${character}unsafe.md`);
      const settings = path.join(box.home, "config.yaml");
      fs.writeFileSync(settings, PLACEHOLDER_ENTRY);
      const before = fs.readdirSync(box.home).sort();
      const result = await box.run(
        ["install", "--agent-mode", "--manual", "--instructions-file", rules, "--mcp-config", settings, ...SETUP],
        { RAGIONEX_API_BASE: mock.base },
      );
      assert.deepEqual(mock.state.requests, [], result.stdout + result.stderr);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.equal(fs.existsSync(rules), false);
      assert.equal(fs.readFileSync(settings, "utf-8"), PLACEHOLDER_ENTRY);
      assert.deepEqual(fs.readdirSync(box.home).sort(), before);
      assert.deepEqual(box.calls(), []);
    });
  }
});

test("manual path preflight refuses an unsafe instructions path typed at the prompt", { skip: NO_TERMINAL }, async (t) => {
  const mock = await startMock(t);
  const box = machine(t, { clis: [], folders: [] });
  const rules = path.join(box.home, 'AGENTS"unsafe.md');
  const settings = path.join(box.home, "config.yaml");
  fs.writeFileSync(settings, PLACEHOLDER_ENTRY);
  const before = fs.readdirSync(box.home).sort();
  const args = ["install", "--manual", ...SETUP];
  const answers = [];
  answers.push(["Path: ", `'${rules}'\r`]);
  answers.push(["Path: ", `${settings}\r`]);
  const result = await terminalInstall(box, mock, answers, args);
  assert.deepEqual(result.unanswered, [], result.output);
  assert.deepEqual(mock.state.requests, [], result.output);
  assert.equal(result.status, 1, result.output);
  assert.equal(fs.existsSync(rules), false);
  assert.equal(fs.readFileSync(settings, "utf-8"), PLACEHOLDER_ENTRY);
  assert.deepEqual(fs.readdirSync(box.home).sort(), before);
  assert.deepEqual(box.calls(), []);
});
