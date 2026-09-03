import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { createCredentialStore, generateCredentialMasterKey } from "../../../src/contexts/llm-gateway/src/credential-store.js";
import { createCredentialAuthorization } from "../../../src/contexts/llm-gateway/src/request-authorization.js";

test("credential store encrypts secrets and public records stay secret-free", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "alice-credentials-"));
  const dbPath = path.join(root, "credentials.sqlite");
  const store = createCredentialStore({ dbPath, masterKey: generateCredentialMasterKey() });
  store.upsert({ id: "api:test", label: "Test", kind: "api_key", provider: "openai-compatible", payload: { apiKey: "super-secret" }, nowMs: 10 });
  assert.deepEqual(store.list(), [{ id: "api:test", label: "Test", kind: "api_key", provider: "openai-compatible", status: "connected", accountLabel: undefined, createdAtMs: 10, updatedAtMs: 10 }]);
  assert.deepEqual(store.readPayload("api:test"), { apiKey: "super-secret" });
  assert.equal(fs.readFileSync(dbPath).includes(Buffer.from("super-secret")), false);
  assert.equal(fs.statSync(dbPath).mode & 0o777, 0o600);
  store.close();
});

test("credential ciphertext and AAD tampering fail closed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "alice-credentials-tamper-"));
  const dbPath = path.join(root, "credentials.sqlite");
  const store = createCredentialStore({ dbPath, masterKey: generateCredentialMasterKey() });
  store.upsert({ id: "api:test", label: "Test", kind: "api_key", provider: "xai", payload: { apiKey: "secret" } });
  const db = new Database(dbPath);
  db.prepare("UPDATE credentials SET provider = 'other' WHERE id = ?").run("api:test");
  db.close();
  assert.throws(() => store.readPayload("api:test"));
  store.close();
});

test("OAuth authorization refreshes once for concurrent callers and rejects non-xAI targets", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "alice-credentials-oauth-"));
  const store = createCredentialStore({ dbPath: path.join(root, "credentials.sqlite"), masterKey: generateCredentialMasterKey() });
  store.upsert({ id: "oauth:xai", label: "xAI", kind: "oauth", provider: "xai", payload: { accessToken: "old", refreshToken: "refresh", expiresAtMs: 1 } });
  let refreshes = 0;
  const authorizationInput = {
    store,
    credentialId: "oauth:xai",
    nowMs: () => 1_000_000,
    async refreshOAuthToken() {
      refreshes += 1;
      await Promise.resolve();
      return { accessToken: "new", expiresAtMs: 2_000_000 };
    }
  };
  const authorization = createCredentialAuthorization(authorizationInput);
  const secondAuthorization = createCredentialAuthorization(authorizationInput);
  assert.deepEqual(await Promise.all([
    authorization.authorization(new URL("https://api.x.ai/v1/responses")),
    secondAuthorization.authorization(new URL("https://api.x.ai/v1/images/edits"))
  ]), ["Bearer new", "Bearer new"]);
  assert.equal(refreshes, 1);
  await assert.rejects(() => authorization.authorization(new URL("https://evil.example/v1/responses")), /oauth_target_not_allowed/);
  store.close();
});

test("deterministic OAuth refresh failures clear unusable tokens and require reconnect", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "alice-credentials-reconnect-"));
  const store = createCredentialStore({ dbPath: path.join(root, "credentials.sqlite"), masterKey: generateCredentialMasterKey() });
  store.upsert({ id: "oauth:xai", label: "xAI", kind: "oauth", provider: "xai", payload: { accessToken: "expired", refreshToken: "revoked", expiresAtMs: 1 } });
  const authorization = createCredentialAuthorization({
    store,
    credentialId: "oauth:xai",
    nowMs: () => 1_000_000,
    async refreshOAuthToken() {
      throw Object.assign(new Error("invalid client token"), { status: 400 });
    }
  });

  await assert.rejects(() => authorization.authorization(new URL("https://api.x.ai/v1/responses")), /credential_reconnect_required/);
  assert.equal(store.get("oauth:xai")?.status, "reconnect_required");
  assert.deepEqual(store.readPayload("oauth:xai"), { accessToken: "", expiresAtMs: 1 });
  store.close();
});
