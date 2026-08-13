/** alice.sqlite 的统一 schema 版本。 */
export const ALICE_SCHEMA_VERSION = 10;

/** v10: Short Memory 表与 UTC 时间索引。迁移为 additive，可安全重复执行。 */
export function initializeShortMemorySchema(db: any): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS short_memory_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      created_at_utc TEXT NOT NULL,
      content TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS short_memory_entries_created_at_utc_idx
      ON short_memory_entries(created_at_utc, id);
  `);
}

export function advanceAliceSchemaVersion(db: any): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
  const currentVersion = Number(row?.user_version ?? 0);
  if (currentVersion < ALICE_SCHEMA_VERSION) {
    db.exec(`PRAGMA user_version = ${ALICE_SCHEMA_VERSION}`);
  }
}
