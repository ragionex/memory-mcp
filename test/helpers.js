import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const ENTRY = fileURLToPath(new URL("../build/index.js", import.meta.url));
export const PACKAGE = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
export const AGENT_CLI_STUB = fileURLToPath(new URL("./agent-cli-stub.js", import.meta.url));

export const apiKey = (letter) => `rgx_memory_${letter.repeat(48)}`;
// The one-time code the mock accepts, and the install flags that send it.
const SETUP_CODE = "K7QFM2XR";
export const SETUP = ["--email", "user@example.com", "--code", "K7QF-M2XR"];
export const text = (result) => result.content?.[0]?.text ?? "";
export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const ACCOUNT_A = "a".repeat(32);
export const ACCOUNT_B = "d".repeat(32);
export const VAULT_A = "b".repeat(32);
export const VAULT_B = "c".repeat(32);
export const projectFile = (folder) => path.join(folder, "RAGIONEX_MEMORY.jsonc");
export const putProjectConfig = (folder, value) => fs.writeFileSync(projectFile(folder), typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
export const queueDirectory = (home, base, key) => path.join(home, ".ragionex", "pending-saves", createHash("sha256").update(JSON.stringify([base, key])).digest("hex"));
export const receiptKey = (operationId, account = ACCOUNT_A) => JSON.stringify([account, operationId]);

const teardowns = new WeakMap();

// node:test runs after() hooks in registration order and skips the rest after a
// failure, so each test gets one hook that undoes setup in reverse and finishes
// every task: a connector exits before the folder it runs in is removed.
function teardown(t, task) {
  let tasks = teardowns.get(t);
  if (!tasks) {
    tasks = [];
    teardowns.set(t, tasks);
    t.after(async () => {
      let failure;
      while (tasks.length) {
        try {
          await tasks.pop()();
        } catch (error) {
          failure ??= error;
        }
      }
      if (failure) throw failure;
    });
  }
  tasks.push(task);
}

export function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rgx-mcp-test-"));
  // Windows can hold a handle in a just-closed folder for a moment; rmSync retries busy entries.
  teardown(t, () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

export async function waitFor(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) return false;
    await pause(50);
  }
  return true;
}

export function spoolFiles(home) {
  const root = path.join(home, ".ragionex", "pending-saves");
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).flatMap((dir) => fs.readdirSync(path.join(root, dir)).map((name) => path.join(root, dir, name)));
}

export const pendingFiles = (home) => spoolFiles(home).filter((file) => file.endsWith(".pending.json"));

/**
 * Local stand-in for the Memory API. `replies.<route>` queues one-shot answers
 * ({ status, headers, body, commit }); `commit` stores the write before failing,
 * like a response lost after the service accepted it.
 */
export async function startMock(t) {
  const state = {
    identity: {
      success: true,
      account_id: ACCOUNT_A,
      key: { key_id: 7, label: "Acme key", permissions: ["read", "create", "update", "delete"] },
      vaults: [{
        vault_id: VAULT_A, vault_name: "My vault", access: "owner",
        permissions: ["read", "create", "update", "delete"], is_default: true,
      }],
    },
    identities: new Map(),
    replies: { identity: [], write: [], update: [], search: [], list: [], view: [], delete: [], status: [],
      trash: [], versions: [], version: [], restore: [], setupCode: [], setupVerify: [] },
    receipts: new Map(),
    charges: 0,
    records: new Map(),
    trash: new Map(),
    deleted: new Set(),
    requests: [],
    issued: [],
    nextId: 1,
    onWrite: null,
    onSearch: null,
  };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : undefined;
      state.requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const send = (status, payload, headers = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(payload));
      };
      const url = new URL(req.url, "http://127.0.0.1");
      const pathname = url.pathname;
      let route = "";
      if (pathname === "/v1/memory/identity" && req.method === "GET") route = "identity";
      else if (pathname === "/v1/memory/search" && req.method === "POST") route = "search";
      else if (pathname === "/v1/memory/write" && req.method === "POST") route = "write";
      else if (pathname === "/v1/memory/list" && req.method === "GET") route = "list";
      else if (pathname === "/v1/memory/view" && req.method === "POST") route = "view";
      else if (pathname === "/v1/memory/update" && req.method === "PUT") route = "update";
      else if (pathname === "/v1/memory/delete" && req.method === "DELETE") route = "delete";
      else if (pathname === "/v1/memory/trash" && req.method === "GET") route = "trash";
      else if (/^\/v1\/memory\/versions\/[^/]+\/\d+$/.test(pathname) && req.method === "GET") route = "version";
      else if (/^\/v1\/memory\/versions\/[^/]+$/.test(pathname) && req.method === "GET") route = "versions";
      else if (pathname === "/v1/memory/restore" && req.method === "POST") route = "restore";
      else if (/^\/v1\/memory\/status\/[^/]+$/.test(pathname) && req.method === "GET") route = "status";
      else if (pathname === "/v1/setup/code" && req.method === "POST") route = "setupCode";
      else if (pathname === "/v1/setup/verify" && req.method === "POST") route = "setupVerify";
      if (route.startsWith("setup")) {
        const scripted = state.replies[route].shift();
        if (scripted) return send(scripted.status, scripted.body ?? { success: false, error: "Scripted failure" }, scripted.headers);
        if (route === "setupCode") return send(200, { success: true, expires_in_seconds: 600 });
        if (body.code !== SETUP_CODE) return send(400, { success: false, error: "The code is not correct.", code: "invalid_code" });
        return send(200, {
          success: true,
          email: body.email,
          keys: body.keys.map(({ name }) => {
            const key = apiKey(String.fromCharCode(102 + state.issued.length));
            state.issued.push(key);
            return { key_id: state.issued.length, label: name, key };
          }),
        });
      }
      const keyIdentity = state.identities.get(req.headers["x-api-key"]);
      if (keyIdentity === null) return send(401, { success: false, error: "Invalid API key", code: "unauthorized" });
      const sourceIdentity = keyIdentity ?? state.identity;
      const identity = {
        ...sourceIdentity,
        vaults: sourceIdentity.vaults.map(vault => ({
          ...vault, permissions: vault.permissions.filter(permission => sourceIdentity.key.permissions.includes(permission)),
        })),
      };
      const operationKey = route === "write"
        ? receiptKey(req.headers["idempotency-key"], identity.account_id)
        : undefined;
      let receipt = operationKey === undefined ? undefined : state.receipts.get(operationKey);
      const header = receipt?.acknowledgement.vault_id ?? req.headers["x-ragionex-vault-id"];
      const vault = header === undefined
        ? identity.vaults.find(item => item.is_default)
        : identity.vaults.find(item => item.vault_id === header);
      if (route !== "identity") {
        if (header !== undefined && !vault) return send(404, { success: false, error: "Vault not found.", code: "vault_not_found" });
        if (!vault) return send(409, { success: false, error: "No default Vault.", code: "no_vault_bound" });
        const permission = route === "write" ? "create"
          : ["update", "restore"].includes(route) ? "update"
            : route === "delete" ? "delete" : "read";
        if (!vault.permissions.includes(permission)) return send(403, { success: false, error: "Permission denied.", code: "no_access" });
      }
      if (route === "write") state.onWrite?.();
      const reply = state.replies[route]?.shift();
      const scripted = () => {
        if (reply.disconnect) {
          res.destroy();
          return;
        }
        const respond = () => send(reply.status, reply.body ?? { success: false, error: "Scripted failure" }, reply.headers);
        if (reply.delayMs) setTimeout(respond, reply.delayMs);
        else respond();
      };
      if (reply && !reply.commit) return scripted();
      if (route === "identity") return send(200, identity);
      if (route === "write") {
        const fingerprint = JSON.stringify(body);
        if (receipt && state.deleted.has(receipt.id)) {
          return send(410, { success: false, error: "Record deleted", code: "record_deleted" });
        }
        if (receipt && receipt.fingerprint !== fingerprint) {
          return send(409, { success: false, error: "Request ID reused", code: "idempotency_mismatch" });
        }
        if (!receipt) {
          let record = [...state.records.values()].find((item) => item.vault_id === vault.vault_id && item.content === body.content);
          if (!record) {
            record = {
              id: `r${state.nextId++}`,
              vault_id: vault.vault_id,
              content: body.content,
              created_at: "2026-09-26T08:30:00Z",
              updated_at: "2026-09-26T08:30:00Z",
              status: "processing",
              revision: 1,
              created_by: identity.account_id,
              updated_by: identity.account_id,
            };
            state.records.set(record.id, record);
          }
          const { content, ...acknowledgement } = record;
          receipt = { fingerprint, id: record.id, acknowledgement };
          state.receipts.set(operationKey, receipt);
          state.charges++;
        }
        if (reply) return scripted();
        return send(200, { success: true, ...receipt.acknowledgement });
      }
      if (route === "update") return send(409, { success: false, error: "Stale revision", code: "revision_conflict" });
      if (route === "search") {
        if (state.onSearch) {
          const response = state.onSearch(body, vault);
          return send(response.status, response.body);
        }
        return send(200, { success: true, results: [], next_cursor: null });
      }
      if (route === "list") return send(200, { success: true, memories: [], next_cursor: null });
      if (route === "trash") return send(200, {
        success: true, memories: [...state.trash.values()].filter(record => record.vault_id === vault.vault_id), next_cursor: null,
      });
      if (route === "view" || route === "delete") {
        const ids = [...new Set(body.ids)];
        const missing = ids.filter((id) => state.records.get(id)?.vault_id !== vault.vault_id);
        if (missing.length) return send(404, { success: false, error: "Not found", code: "not_found", not_found_ids: missing });
        if (route === "view") return send(200, { success: true, memories: ids.map((id) => state.records.get(id)) });
        for (const id of ids) {
          const record = state.records.get(id);
          const now = Date.now();
          state.trash.set(id, {
            ...record, status: "trashed", revision: record.revision + 1,
            updated_at: new Date(now).toISOString(), updated_by: identity.account_id, deleted_at: new Date(now).toISOString(),
            expires_at: new Date(now + 30 * 86400000).toISOString(),
          });
          state.records.delete(id);
          state.deleted.add(id);
        }
        return send(200, { success: true, deleted: ids.length });
      }
      return send(404, { success: false, error: "Not found", code: "not_found" });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return {
    state,
    base: `http://127.0.0.1:${server.address().port}`,
    writes: () => state.requests.filter((request) => request.method === "POST" && request.url === "/v1/memory/write"),
  };
}

/** Starts the built server over stdio, like an agent does. */
export async function connect(t, { home, base, key, env = {}, name = "test-client", cwd = home, roots, nodeArgs = [], onStderr }) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...nodeArgs, ENTRY],
    cwd,
    env: {
      HOME: home,
      USERPROFILE: home,
      ...(base ? { RAGIONEX_API_BASE: base } : {}),
      ...(key ? { RAGIONEX_MEMORY_API_KEY: key } : {}),
      ...env,
    },
    stderr: "pipe",
  });
  const client = new Client({ name, version: "1.0.0" }, { capabilities: roots === undefined ? {} : { roots: {} } });
  if (roots !== undefined) {
    client.setRequestHandler(ListRootsRequestSchema, async () => {
      const listed = typeof roots === "function" ? await roots() : roots;
      if (listed instanceof Error) throw listed;
      return { roots: listed };
    });
  }
  transport.stderr?.on("data", (chunk) => onStderr?.(chunk.toString()));
  await client.connect(transport);
  teardown(t, () => client.close());
  return client;
}

/**
 * A temporary machine for the installer: its own home with the given agent
 * folders, and stub agent CLIs as the only programs on PATH.
 */
export function machine(t, { clis = ["claude", "codex", "opencode"], folders = [".claude"] } = {}) {
  const root = tempDir(t);
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(home);
  for (const folder of folders) fs.mkdirSync(path.join(home, folder), { recursive: true });
  for (const cli of clis) {
    if (process.platform === "win32") {
      // The installer runs agent CLIs through cmd.exe, which finds .cmd shims on PATH.
      fs.writeFileSync(path.join(bin, `${cli}.cmd`), `@"${process.execPath}" "${AGENT_CLI_STUB}" ${cli} %*\r\n`);
    } else {
      const launcher = `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(AGENT_CLI_STUB)} ${cli} "$@"\n`;
      fs.writeFileSync(path.join(bin, cli), launcher, { mode: 0o755 });
    }
  }
  return {
    root,
    home,
    // Asynchronous, so a mock API served by this test process can answer the installer.
    run: (args, env = {}) => new Promise((resolve) => {
      const child = execFile(process.execPath, [ENTRY, ...args], {
        cwd: root,
        // A local default API address keeps every installer run away from the real service.
        // cmd.exe is found through ComSpec, which every real Windows session sets.
        env: {
          HOME: home, USERPROFILE: home, PATH: bin, RAGIONEX_API_BASE: "http://127.0.0.1:9",
          ...(process.platform === "win32" ? { ComSpec: process.env.ComSpec } : {}),
          ...env,
        },
        timeout: 60_000,
      }, (error, stdout, stderr) => resolve({ status: error ? error.code : 0, stdout, stderr }));
      child.stdin.end();
    }),
    calls: () => {
      const log = path.join(home, "cli-calls.log");
      return fs.existsSync(log) ? fs.readFileSync(log, "utf-8").trim().split("\n").map((line) => JSON.parse(line)) : [];
    },
  };
}
