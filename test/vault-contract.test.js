import assert from "node:assert/strict";
import test from "node:test";
import { identitySchema, recordAckSchema, savedRecordSchema } from "../build/memory-contract.js";
import { ACCOUNT_A, VAULT_A, apiKey, connect, startMock, tempDir, text } from "./helpers.js";

test("identity contains account key metadata and reachable Vaults without a selected field", async (t) => {
  const mock = await startMock(t);
  const identity = mock.state.identity;
  assert.deepEqual(identitySchema.parse(identity), identity);
  assert.deepEqual(identitySchema.parse({ ...identity, vault_id: VAULT_A }), identity);
  assert.equal(identitySchema.safeParse({ ...identity, account_id: "account" }).success, false);
  assert.equal(identitySchema.safeParse({ ...identity, key: { ...identity.key, key_id: 0 } }).success, false);
  assert.equal(identitySchema.safeParse({ ...identity, vaults: [{ ...identity.vaults[0], vault_id: "vault" }] }).success, false);
  assert.deepEqual(identitySchema.parse({ ...identity, vaults: [] }).vaults, []);
});

test("acknowledgements omit content and require their Vault and account actors", () => {
  const acknowledgement = {
    id: "mem_A", vault_id: VAULT_A, created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z", status: "future_status", revision: 1,
    created_by: ACCOUNT_A, updated_by: ACCOUNT_A,
  };
  assert.deepEqual(recordAckSchema.parse({ ...acknowledgement, content: "Private text.", extra_fixture: true }), acknowledgement);
  assert.equal(savedRecordSchema.safeParse(acknowledgement).success, false);
  assert.deepEqual(savedRecordSchema.parse({ ...acknowledgement, content: "A durable fact." }), { ...acknowledgement, content: "A durable fact." });
  assert.equal(recordAckSchema.safeParse({ ...acknowledgement, created_by: "Acme key" }).success, false);
  assert.equal(recordAckSchema.safeParse({ ...acknowledgement, updated_by: null }).success, false);
  const withoutVault = { ...acknowledgement };
  delete withoutVault.vault_id;
  for (const value of [withoutVault, { ...acknowledgement, vault_id: null }, { ...acknowledgement, vault_id: "vault" }]) {
    assert.equal(recordAckSchema.safeParse(value).success, false);
  }
});

test("reachable Vaults with no common permission remain visible while operations fail", async (t) => {
  const mock = await startMock(t);
  mock.state.identity.key.permissions = ["read"];
  mock.state.identity.vaults[0].permissions = ["create"];
  const client = await connect(t, { home: tempDir(t), base: mock.base, key: apiKey("v") });
  const result = await client.callTool({ name: "ragionex_memory_connection", arguments: {} });
  assert.ok(!result.isError, text(result));
  const report = JSON.parse(text(result));
  assert.equal(report.identity.vaults[0].vault_id, VAULT_A);
  assert.deepEqual(report.identity.vaults[0].permissions, []);
  const denied = await client.callTool({ name: "ragionex_list_memories", arguments: {} });
  assert.equal(denied.isError, true);
  assert.match(text(denied), /no_access/);
  assert.doesNotMatch(text(denied), /No records were returned/);
});
