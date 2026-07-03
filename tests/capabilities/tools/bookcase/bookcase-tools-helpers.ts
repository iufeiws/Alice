import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as sqlite from "../../../../src/platform/storage/src/sqlite-compat.js";

export const fixtureSummary = "A wanderer finds a hidden moon gate and must choose between saving a village and claiming a crown.";

export function createFixtureDb(): string {
  const dir = path.join(os.tmpdir(), "alice-tests", `alice-bookcase-tool-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "books.sqlite");
  const db: any = new sqlite.DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE books (
      id INTEGER PRIMARY KEY,
      wiki_id TEXT,
      freebase_id TEXT,
      title TEXT NOT NULL,
      author TEXT NOT NULL,
      publication_date TEXT NOT NULL,
      summary TEXT NOT NULL,
      summary_chars INTEGER NOT NULL
    );
    CREATE TABLE book_genres (
      book_id INTEGER NOT NULL,
      genre TEXT NOT NULL
    );
  `);
  db.prepare(`
    INSERT INTO books (wiki_id, freebase_id, title, author, publication_date, summary, summary_chars)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("1", "/m/test", "Moon Gate", "A. Writer", "2001", fixtureSummary, fixtureSummary.length);
  db.prepare("INSERT INTO book_genres (book_id, genre) VALUES (?, ?)").run(1, "Fantasy");
  db.prepare("INSERT INTO book_genres (book_id, genre) VALUES (?, ?)").run(1, "Fiction");
  db.close();
  return dbPath;
}

export function fixtureCounts(dbPath: string): { books: number; genres: number } {
  const db: any = new sqlite.DatabaseSync(dbPath, { readOnly: true });
  const counts = {
    books: Number(db.prepare("SELECT COUNT(*) AS count FROM books").get().count),
    genres: Number(db.prepare("SELECT COUNT(*) AS count FROM book_genres").get().count)
  };
  db.close();
  return counts;
}

export function fixedTime() {
  const date = new Date("2026-05-25T00:00:00.000Z");
  return {
    timeZone: "Asia/Singapore",
    now() {
      return { date, epochMs: date.getTime(), timeZone: "Asia/Singapore", iso: "2026-05-25T08:00:00.000" };
    },
    addMs() {
      return this.now();
    }
  };
}
