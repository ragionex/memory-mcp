// Stand-in for the claude, codex, opencode and hermes CLIs in installer tests. It edits
// the same config files the real CLIs own and logs every call.
import fs from "node:fs";
import path from "node:path";
import { parse, printParseErrorCode } from "jsonc-parser";

const [agent, ...args] = process.argv.slice(2);
const home = process.env.HOME;
fs.appendFileSync(path.join(home, "cli-calls.log"), `${JSON.stringify([agent, ...args])}\n`);

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (process.env.STUB_FAIL === [agent, ...args.slice(0, 2)].join(" ")) {
  fail(`${agent} ${args.join(" ")}: simulated failure`);
}

const [, command, name] = args;
const split = args.indexOf("--");
const launch = split < 0 ? [] : args.slice(split + 1);
const env = {};
for (let i = 3; i < (split < 0 ? args.length : split); i++) {
  if (args[i] === "-e" || args[i] === "--env") {
    const [key, ...value] = args[++i].split("=");
    env[key] = value.join("=");
  }
}

function claude() {
  const file = path.join(process.env.CLAUDE_CONFIG_DIR || home, ".claude.json");
  const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf-8")) : {};
  const servers = config.mcpServers ?? {};
  if (command === "add") {
    if (servers[name]) fail(`MCP server ${name} already exists in user config`);
    servers[name] = { type: "stdio", command: launch[0], args: launch.slice(1), env };
  } else if (command === "remove") {
    if (!servers[name]) fail(`No MCP server named "${name}" in user scope`);
    delete servers[name];
  }
  fs.writeFileSync(file, JSON.stringify({ ...config, mcpServers: servers }, null, 2));
}

function codex() {
  const dir = process.env.CODEX_HOME || path.join(home, ".codex");
  const file = path.join(dir, "config.toml");
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
  if (command === "list") {
    return;
  }
  let next = current.split(/\n(?=\[)/).filter((table) => !table.startsWith(`[mcp_servers.${name}`)).join("\n");
  if (command === "add") {
    const pairs = Object.entries(env).map(([key, value]) => `${key} = ${JSON.stringify(value)}`);
    next += `\n[mcp_servers.${name}]\ncommand = ${JSON.stringify(launch[0])}\nargs = ${JSON.stringify(launch.slice(1))}\n`;
    if (pairs.length) next += `\n[mcp_servers.${name}.env]\n${pairs.join("\n")}\n`;
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, next);
}

function opencode() {
  const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "opencode");
  const file = path.join(dir, "opencode.jsonc");
  let config;
  try {
    const errors = [];
    config = parse(fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "{}", errors, { allowTrailingComma: true });
    if (errors.length) throw new Error(printParseErrorCode(errors[0].error));
  } catch {
    fail(`Error: Config file at ${file} is not valid JSON(C)`);
  }
  if (command === "add") {
    config.mcp = { ...config.mcp, [name]: { type: "local", command: launch, environment: env } };
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(config, null, 2));
  }
}

// Hermes keeps its settings as YAML in its active home: HERMES_HOME, else the sticky profile,
// else its default folder. It asks before it saves and reads one answer per line of standard
// input; the end of input answers a question with null.
function hermes() {
  const root = process.env.HERMES_HOME || (process.platform === "win32"
    ? path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "hermes")
    : path.join(home, ".hermes"));
  const sticky = path.join(root, "active_profile");
  const profile = !process.env.HERMES_HOME && fs.existsSync(sticky) ? fs.readFileSync(sticky, "utf-8").trim() : "";
  const dir = profile && profile !== "default" ? path.join(root, "profiles", profile) : root;
  const file = path.join(dir, "config.yaml");
  if (args[0] === "config" && command === "path") {
    console.log(file);
    return;
  }
  let input = "";
  try {
    input = fs.readFileSync(0, "utf-8");
  } catch {
    // No standard input reads as its end.
  }
  fs.appendFileSync(path.join(home, "hermes-input.log"), `${JSON.stringify(input)}\n`);
  const answers = input.split("\n");
  const ask = (question) => {
    process.stdout.write(question);
    return answers.length === 1 && answers[0] === "" ? null : answers.shift();
  };
  const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf-8").split("\n") : [];
  const at = lines.indexOf(`  ${name}:`);
  let end = at + 1;
  while (at >= 0 && end < lines.length && lines[end].startsWith("    ")) end++;
  const save = () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, lines.join("\n"));
  };
  if (command === "remove") {
    if (at < 0) fail(`Server '${name}' not found.`);
    const answer = ask(`Remove server '${name}'? [Y/n] `);
    if (answer !== null && !["", "y"].includes(answer.trim().toLowerCase())) return console.log("Cancelled.");
    lines.splice(at, end - at);
    return save();
  }
  if (at >= 0) {
    if (ask(`Server '${name}' already exists. Overwrite? [y/N] `)?.trim().toLowerCase() !== "y") return console.log("Cancelled.");
    lines.splice(at, end - at);
  }
  let enabled = true;
  if (process.env.STUB_HERMES_PROBE === "fail") {
    if (ask("Save config anyway (you can test later)? [y/N] ")?.trim().toLowerCase() !== "y") return console.log("Nothing saved.");
    enabled = false;
  } else {
    const answer = ask("Enable all 11 tools? [Y/n/select] ");
    if (answer === null || !["", "y"].includes(answer.trim().toLowerCase())) return console.log("Cancelled.");
  }
  const after = (option) => args.indexOf(option) + 1;
  const entry = [
    `  ${name}:`,
    `    command: ${args[after("--command")]}`,
    "    args:",
    ...args.slice(after("--args")).map((arg) => `    - '${arg}'`),
    "    env:",
    ...args.slice(after("--env"), after("--args") - 1)
      .map((pair) => `      ${pair.slice(0, pair.indexOf("="))}: '${pair.slice(pair.indexOf("=") + 1)}'`),
    `    enabled: ${enabled}`,
  ];
  const section = lines.indexOf("mcp_servers:");
  if (section < 0) lines.push("mcp_servers:", ...entry, "");
  else lines.splice(section + 1, 0, ...entry);
  save();
}

({ claude, codex, opencode, hermes })[agent]();
