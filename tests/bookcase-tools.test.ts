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
  assert.equal(result.resetLLMSession, true);
  assert.equal(result.fixedPrefixKind, "bookcase");
  assert.equal(result.fixedPrefixTtlMs, 2 * 60 * 60 * 1000);
  const output = String(result.output);
  assert.match(output, /^<book>/);
  assert.match(output, /<title>Moon Gate<\/title>/);
  assert.match(output, /- Fantasy/);
  assert.match(output, /- Fiction/);
  assert.match(output, /hidden moon gate/);
  assert.match(output, /为YY讲述这个故事/);
  assert.doesNotMatch(output, /\{\{user\}\}/);
  assert.match(output, /toolcall action = return/);
  assert.match(output, /<time>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}<\\time>/);
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
  assert.equal(result.resetLLMSession, true);
  assert.equal(result.clearFixedPrefix, true);
  assert.equal(result.invalidateLLMSession, true);
  const output = String(result.output);
  assert.match(output, /<bookcase action="return" invalidate_llm_session="true">/);
  assert.match(output, /<message>.*重开.*<\/message>/);
});

test("bookcase tool sends system notices when drawing and returning books", async () => {
  const sent: string[] = [];
  const stored: Array<{ contentText: string; senderRole?: string }> = [];
  const logs: Array<{ status?: string; summary: string }> = [];
  const store = {
    insertOutboundMessage(input: any) {
      stored.push({ contentText: input.contentText, senderRole: input.senderRole });
      return { id: stored.length, ...input };
    },
    markOutboundMessageSent() {},
    markOutboundMessageFailed() {}
  };
  const tools = createBookcaseTools({
    dbPath: createFixtureDb(),
    store,
    outputRouter: {
      async send(output) {
        sent.push(output.content.kind === "text" ? output.content.text : "");
        return { messageId: `notice_${sent.length}` };
      }
    },
    appendMessageLog(input) {
      logs.push({ status: input.status, summary: input.summary });
    }
  });
  const baseCall = {
    requester: { plugin: "feishu", channelId: "chat-1" },
    session: { scope: "dm" as const, sessionId: "session-1" }
  };

  await tools.execute({
    ...baseCall,
    id: "call_bookcase_draw_notice",
    toolName: "bookcase",
    input: { action: "draw", seed: 1, minSummaryChars: 10 }
  });
  await tools.execute({
    ...baseCall,
    id: "call_bookcase_return_notice",
    toolName: "bookcase",
    input: { action: "return" }
  });

  assert.deepEqual(sent, ["-少女已取书-", "-少女已还书-"]);
  assert.deepEqual(stored, [
    { contentText: "-少女已取书-", senderRole: "system" },
    { contentText: "-少女已还书-", senderRole: "system" }
  ]);
  assert.deepEqual(logs, [
    { status: "sent", summary: "-少女已取书-" },
    { status: "sent", summary: "-少女已还书-" }
  ]);
});

test("bookcase notice failures do not block draw or return transitions", async () => {
  const failed: Array<{ id: number; reason?: string }> = [];
  const logs: Array<{ status?: string; summary: string; error?: string }> = [];
  const store = {
    insertOutboundMessage(input: any) {
      return { id: input.contentText === "-少女已取书-" ? 1 : 2, ...input };
    },
    markOutboundMessageSent() {},
    markOutboundMessageFailed(id: number, _time: string, reason: string) {
      failed.push({ id, reason });
    }
  };
  const tools = createBookcaseTools({
    dbPath: createFixtureDb(),
    store,
    outputRouter: {
      async send() {
        throw new Error("notice offline");
      }
    },
    appendMessageLog(input) {
      logs.push({ status: input.status, summary: input.summary, error: input.error });
    }
  });
  const baseCall = {
    requester: { plugin: "feishu", channelId: "chat-1" },
    session: { scope: "dm" as const, sessionId: "session-1" }
  };

  const draw = await tools.execute({
    ...baseCall,
    id: "call_bookcase_draw_notice_failed",
    toolName: "bookcase",
    input: { action: "draw", seed: 1, minSummaryChars: 10 }
  });
  const returned = await tools.execute({
    ...baseCall,
    id: "call_bookcase_return_notice_failed",
    toolName: "bookcase",
    input: { action: "return" }
  });

  assert.equal(draw.ok, true);
  assert.equal(draw.resetLLMSession, true);
  assert.equal(draw.fixedPrefixKind, "bookcase");
  assert.equal(returned.ok, true);
  assert.equal(returned.resetLLMSession, true);
  assert.equal(returned.clearFixedPrefix, true);
  assert.deepEqual(failed, [
    { id: 1, reason: "notice offline" },
    { id: 2, reason: "notice offline" }
  ]);
  assert.deepEqual(logs, [
    { status: "send_failed", summary: "-少女已取书-", error: "notice offline" },
    { status: "send_failed", summary: "-少女已还书-", error: "notice offline" }
  ]);
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
