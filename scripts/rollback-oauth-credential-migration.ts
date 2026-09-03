import { restoreLegacyPresetSnapshot } from "./oauth-credential-rollback.js";

const masterKey = process.env.ALICE_CREDENTIAL_MASTER_KEY;
if (!masterKey) throw new Error("ALICE_CREDENTIAL_MASTER_KEY is required");
restoreLegacyPresetSnapshot({
  memoryRoot: process.argv[2] ?? "memory-files",
  masterKey,
  photoConfigPath: process.argv[3] ?? "config/plugin/photo/config.json"
});
console.log("已恢复 LLM preset 与可用的照片配置加密快照；credential 数据库未自动删除。");
