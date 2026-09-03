import Database from "better-sqlite3";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type CredentialKind = "api_key" | "oauth";
export type CredentialStatus = "connected" | "reconnect_required";

export type CredentialRecord = {
  id: string;
  label: string;
  kind: CredentialKind;
  provider: string;
  status: CredentialStatus;
  accountLabel?: string;
  createdAtMs: number;
  updatedAtMs: number;
};

export type ApiKeyCredentialPayload = { apiKey: string };
export type OAuthCredentialPayload = {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  scope?: string;
  expiresAtMs?: number;
  subject?: string;
};
export type CredentialPayload = ApiKeyCredentialPayload | OAuthCredentialPayload;

export type CredentialStore = ReturnType<typeof createCredentialStore>;

export function createCredentialStore(input: { dbPath: string; masterKey: string }) {
  const key = decodeMasterKey(input.masterKey);
  fs.mkdirSync(path.dirname(input.dbPath), { recursive: true, mode: 0o700 });
  const db = new Database(input.dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS credentials (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('api_key', 'oauth')),
      provider TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('connected', 'reconnect_required')),
      account_label TEXT,
      encrypted_payload BLOB NOT NULL,
      iv BLOB NOT NULL,
      auth_tag BLOB NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    )
  `);
  fs.chmodSync(input.dbPath, 0o600);

  const selectPublic = `
    SELECT id, label, kind, provider, status, account_label AS accountLabel,
           created_at_ms AS createdAtMs, updated_at_ms AS updatedAtMs
    FROM credentials`;

  return {
    close(): void {
      db.close();
    },
    list(): CredentialRecord[] {
      return db.prepare(`${selectPublic} ORDER BY label, id`).all().map(normalizeRecord);
    },
    get(id: string): CredentialRecord | undefined {
      const row = db.prepare(`${selectPublic} WHERE id = ?`).get(id);
      return row ? normalizeRecord(row) : undefined;
    },
    readPayload(id: string): CredentialPayload {
      const row = db.prepare(`
        SELECT id, label, kind, provider, status, encrypted_payload AS encryptedPayload,
               iv, auth_tag AS authTag
        FROM credentials WHERE id = ?
      `).get(id) as EncryptedRow | undefined;
      if (!row) throw new Error("credential_not_found");
      return decryptPayload(key, row);
    },
    upsert(inputValue: {
      id: string;
      label: string;
      kind: CredentialKind;
      provider: string;
      status?: CredentialStatus;
      accountLabel?: string;
      payload: CredentialPayload;
      nowMs?: number;
    }): CredentialRecord {
      validateMetadata(inputValue);
      const nowMs = inputValue.nowMs ?? Date.now();
      const status = inputValue.status ?? "connected";
      const aad = metadataAad(inputValue.id, inputValue.kind, inputValue.provider);
      const encrypted = encryptPayload(key, inputValue.payload, aad);
      db.prepare(`
        INSERT INTO credentials(
          id, label, kind, provider, status, account_label, encrypted_payload, iv, auth_tag,
          created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          label = excluded.label,
          kind = excluded.kind,
          provider = excluded.provider,
          status = excluded.status,
          account_label = excluded.account_label,
          encrypted_payload = excluded.encrypted_payload,
          iv = excluded.iv,
          auth_tag = excluded.auth_tag,
          updated_at_ms = excluded.updated_at_ms
      `).run(
        inputValue.id, inputValue.label, inputValue.kind, inputValue.provider, status,
        inputValue.accountLabel ?? null, encrypted.ciphertext, encrypted.iv, encrypted.authTag,
        nowMs, nowMs
      );
      return this.get(inputValue.id)!;
    },
    markReconnectRequired(id: string, payload: CredentialPayload, nowMs = Date.now()): void {
      const record = this.get(id);
      if (!record) throw new Error("credential_not_found");
      this.upsert({ ...record, status: "reconnect_required", payload, nowMs });
    },
    delete(id: string): boolean {
      return db.prepare("DELETE FROM credentials WHERE id = ?").run(id).changes > 0;
    }
  };
}

export function generateCredentialMasterKey(): string {
  return randomBytes(32).toString("base64url");
}

function decodeMasterKey(value: string): Buffer {
  const key = Buffer.from(value, "base64url");
  if (key.byteLength !== 32) throw new Error("invalid_credential_master_key");
  return key;
}

function validateMetadata(value: { id: string; label: string; provider: string }): void {
  if (!value.id.trim() || !/^[a-zA-Z0-9._:-]+$/.test(value.id)) throw new Error("invalid_credential_id");
  if (!value.label.trim()) throw new Error("invalid_credential_label");
  if (!value.provider.trim()) throw new Error("invalid_credential_provider");
}

function metadataAad(id: string, kind: string, provider: string): Buffer {
  return Buffer.from(JSON.stringify({ id, kind, provider }), "utf8");
}

function encryptPayload(key: Buffer, payload: CredentialPayload, aad: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

function decryptPayload(key: Buffer, row: EncryptedRow): CredentialPayload {
  const decipher = createDecipheriv("aes-256-gcm", key, row.iv);
  decipher.setAAD(metadataAad(row.id, row.kind, row.provider));
  decipher.setAuthTag(row.authTag);
  const cleartext = Buffer.concat([decipher.update(row.encryptedPayload), decipher.final()]).toString("utf8");
  return JSON.parse(cleartext) as CredentialPayload;
}

type EncryptedRow = {
  id: string;
  label: string;
  kind: CredentialKind;
  provider: string;
  status: CredentialStatus;
  encryptedPayload: Buffer;
  iv: Buffer;
  authTag: Buffer;
};

function normalizeRecord(row: unknown): CredentialRecord {
  const value = row as CredentialRecord;
  return {
    id: String(value.id),
    label: String(value.label),
    kind: value.kind,
    provider: String(value.provider),
    status: value.status,
    accountLabel: value.accountLabel || undefined,
    createdAtMs: Number(value.createdAtMs),
    updatedAtMs: Number(value.updatedAtMs)
  };
}
