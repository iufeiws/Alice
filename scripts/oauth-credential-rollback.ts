import { createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

type EncryptedSnapshot = { version: 1; iv: string; authTag: string; ciphertext: string };

export function restoreLegacyPresetSnapshot(input: { memoryRoot: string; masterKey: string; photoConfigPath?: string }): void {
  const configDir = path.join(input.memoryRoot, "config");
  const snapshotPath = path.join(configDir, "llm-api-presets-v1.snapshot.enc.json");
  let restored = false;
  if (fs.existsSync(snapshotPath)) {
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8")) as EncryptedSnapshot;
    writeAtomic(path.join(configDir, "llm-api-presets.json"), decryptSnapshot(snapshot, input.masterKey, "alice:llm-api-presets:v1"), 0o600);
    restored = true;
  }
  if (input.photoConfigPath) {
    const photoSnapshotPath = `${input.photoConfigPath}.oauth-v1.snapshot.enc.json`;
    if (fs.existsSync(photoSnapshotPath)) {
      const photoSnapshot = JSON.parse(fs.readFileSync(photoSnapshotPath, "utf8")) as EncryptedSnapshot;
      writeAtomic(input.photoConfigPath, decryptSnapshot(photoSnapshot, input.masterKey, "alice:photo-config:xai-key:v1"), 0o600);
      restored = true;
    }
  }
  if (!restored) throw new Error("credential_migration_snapshot_not_found");
}

function decryptSnapshot(snapshot: EncryptedSnapshot, masterKey: string, aad: string): string {
  if (snapshot.version !== 1) throw new Error("unsupported_credential_snapshot");
  const key = Buffer.from(masterKey, "base64url");
  if (key.byteLength !== 32) throw new Error("invalid_credential_master_key");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(snapshot.iv, "base64url"));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(snapshot.authTag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(snapshot.ciphertext, "base64url")), decipher.final()]).toString("utf8");
}

function writeAtomic(filePath: string, content: string, mode: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, content, { mode });
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, mode);
}
