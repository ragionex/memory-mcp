import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { parseConfig, readConfig } from "../build/vault-config.js";
import { VAULT_A, VAULT_B, apiKey, projectFile, putProjectConfig, tempDir } from "./helpers.js";

const KEY_A = apiKey("a");
const KEY_B = apiKey("b");

test("three resolution cases select the file Vault and prescribed credential", (t) => {
  const folder = tempDir(t);
  const absent = readConfig(folder, KEY_A);
  assert.equal(absent.key, KEY_A);
  assert.equal(absent.vaultId, undefined);
  assert.equal(absent.details.vault_source, "account_default");
  putProjectConfig(folder, { vault_id: VAULT_A });
  const environment = readConfig(folder, KEY_A);
  assert.equal(environment.key, KEY_A);
  assert.equal(environment.vaultId, VAULT_A);
  assert.equal(environment.details.key_source, "environment");
  putProjectConfig(folder, { vault_id: VAULT_A, api_key: KEY_B });
  const explicit = readConfig(folder, KEY_A);
  assert.equal(explicit.key, KEY_B);
  assert.equal(explicit.vaultId, VAULT_A);
  assert.equal(explicit.details.key_source, "project_file");
  assert.equal(explicit.filePath, projectFile(folder));
  assert.equal(JSON.stringify(explicit.details).includes(KEY_B), false);
});

test("JSONC accepts comments and trailing commas and rejects unknown fields", () => {
  assert.deepEqual(parseConfig(`// keep header\n{"vault_id":"${VAULT_A}", /* keep note */}`), { vault_id: VAULT_A });
  for (const value of ["[]", "{}", `{"vault_id":"${VAULT_A}","extra":true}`, `{"vault_id":"${VAULT_A.toUpperCase()}"}`, `{"vault_id":"${VAULT_A}","api_key":""}`]) {
    assert.throws(() => parseConfig(value), /shape/);
  }
  assert.throws(() => parseConfig('{\n "vault_id": [broken]\n}\n'), /syntax.*line 2, column \d+/);
});

test("invalid explicit credentials never use the environment and diagnostics omit secrets", (t) => {
  const folder = tempDir(t);
  for (const key of ["bad key", "bad\r\nkey", "", "bad\u0000key"]) {
    putProjectConfig(folder, { vault_id: VAULT_A, api_key: key });
    assert.throws(() => readConfig(folder, KEY_A), error => {
      assert.equal(error.code, "config_error");
      assert.equal(error.message.includes(KEY_A), false);
      if (key) assert.equal(error.message.includes(key), false);
      return true;
    });
  }
  putProjectConfig(folder, { vault_id: VAULT_A, api_key: "legacy.secret-123" });
  assert.equal(readConfig(folder, KEY_A).key, "legacy.secret-123");
});

test("unreadable or malformed files fail and repairs are read immediately", (t) => {
  const folder = tempDir(t);
  fs.mkdirSync(projectFile(folder));
  assert.throws(() => readConfig(folder, KEY_A), /read_failed/);
  fs.rmdirSync(projectFile(folder));
  putProjectConfig(folder, "{");
  assert.throws(() => readConfig(folder, KEY_A), /syntax/);
  putProjectConfig(folder, { vault_id: VAULT_B });
  assert.equal(readConfig(folder, KEY_A).vaultId, VAULT_B);
  fs.unlinkSync(projectFile(folder));
  assert.equal(readConfig(folder, KEY_A).vaultId, undefined);
});

test("reads preserve the project file's bytes, mode and folder", (t) => {
  const folder = tempDir(t);
  const original = `// keep\r\n{ "vault_id" : "${VAULT_A}", "api_key" : "${KEY_B}", }\r\n`;
  putProjectConfig(folder, original);
  const mode = fs.statSync(projectFile(folder)).mode;
  const files = fs.readdirSync(folder).sort();
  for (let count = 0; count < 3; count++) assert.equal(readConfig(folder, KEY_A).key, KEY_B);
  assert.equal(fs.readFileSync(projectFile(folder), "utf-8"), original);
  assert.equal(fs.statSync(projectFile(folder)).mode, mode);
  assert.deepEqual(fs.readdirSync(folder).sort(), files);
});
