import BetterSqlite3 from "better-sqlite3";

export type DatabaseSyncOptions = {
  readOnly?: boolean;
};

export class DatabaseSync {
  private readonly db: any;

  constructor(dbPath: string, options: DatabaseSyncOptions = {}) {
    this.db = new (BetterSqlite3 as any)(dbPath, {
      readonly: options.readOnly ?? false
    });
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): any {
    return this.db.prepare(sql);
  }

  close(): void {
    this.db.close();
  }
}
