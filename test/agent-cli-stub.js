// Stand-in for the claude, codex and opencode CLIs in installer tests. It edits
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
    if (current.includes("MALFORMED")) fail("Error: failed to load configuration");
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

({ claude, codex, opencode })[agent]();
