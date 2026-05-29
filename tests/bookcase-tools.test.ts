import { test } from "node:test";
import assert from "node:assert/strict";
import { createBookcaseTools } from "../plugins/bookcase/src/index.js";

const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");
const sqlite = await import("node:sqlite");

test("bookcase tool draws a book and includes retelling instructions", async () => {
  const dbPath = createFixtureDb();
  const tools = createBookcaseTools({ dbPath, getUserName: () => "YY" });

  const result = await tools.execute({
    id: "call_bookcase",
    toolName: "bookcase",
    input: { action: "draw", genre: "Fantasy", seed: 7, minSummaryChars: 10 }
  });

  assert.equal(result.ok, true);
  const output = String(result.output);
  assert.match(output, /^<book>/);
  assert.match(output, /<title>Moon Gate<\/title>/);
  assert.match(output, /- Fantasy/);
  assert.match(output, /- Fiction/);
  assert.match(output, /hidden moon gate/);
  assert.match(output, /为YY讲述这个故事/);
  assert.doesNotMatch(output, /\{\{user\}\}/);
  assert.match(output, /toolcall action = return/);
  assert.doesNotMatch(output, /summary_chars/);
  assert.doesNotMatch(output, /source_line/);
  assert.doesNotMatch(output, /name_bank/);
});

test("bookcase tool reports no matching summaries", async () => {
  const dbPath = createFixtureDb();
  const tools = createBookcaseTools({ dbPath });

  const result = await tools.execute({
    id: "call_bookcase_none",
    toolName: "bookcase",
    input: { action: "draw", title: "missing" }
  });

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /no matching/);
});

test("bookcase tool returns a book and invalidates the LLM session", async () => {
  const tools = createBookcaseTools({ dbPath: createFixtureDb() });

  const result = await tools.execute({
    id: "call_bookcase_return",
    toolName: "bookcase",
    input: { action: "return" }
  });

  assert.equal(result.ok, true);
  assert.equal(result.invalidateLLMSession, true);
  const output = String(result.output);
  assert.match(output, /<bookcase action="return" invalidate_llm_session="true">/);
  assert.match(output, /<message>.*重开.*<\/message>/);
});

function createFixtureDb(): string {
  const dir = path.join(os.tmpdir(), `alice-bookcase-tool-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
  const summary = "A wanderer finds a hidden moon gate and must choose between saving a village and claiming a crown.";
  db.prepare(`
    INSERT INTO books (wiki_id, freebase_id, title, author, publication_date, summary, summary_chars)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("1", "/m/test", "Moon Gate", "A. Writer", "2001", summary, summary.length);
  db.prepare("INSERT INTO book_genres (book_id, genre) VALUES (?, ?)").run(1, "Fantasy");
  db.prepare("INSERT INTO book_genres (book_id, genre) VALUES (?, ?)").run(1, "Fiction");
  db.close();
  return dbPath;
}
