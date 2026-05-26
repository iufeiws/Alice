import { test } from "node:test";
import assert from "node:assert/strict";
import { createMutableLLMClient, createOpenAICompatibleClient, type LLMClient } from "../core/llm/src/index.js";
import { createAliceStore } from "../packages/storage/src/sqlite-store.js";

const fs = await import("node:fs");
const path = await import("node:path");
const sqlite = await import("node:sqlite");

test("mutable LLM client delegates to the latest configured client", async () => {
  const first = namedClient("first");
  const second = namedClient("second");
  const client = createMutableLLMClient(first);

  assert.equal((await client.chat({ messages: [] })).message.content, "first");
  client.setClient(second);
  assert.equal((await client.chat({ messages: [] })).message.content, "second");
  assert.deepEqual(await client.listModels?.(), [{ id: "second" }]);
});

test("openai stream client processes a final SSE frame without trailing newline", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: any;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(
        [
          'data: {"id":"chat_1","model":"test","choices":[{"delta":{"reasoning_content":"think "}}]}',
          'data: {"id":"chat_1","model":"test","choices":[{"delta":{"reasoning_content":"more"}}]}',
          'data: {"id":"chat_1","model":"test","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"check_feishu","arguments":"{\\"scope\\":\\"today\\"}"}}]},"finish_reason":"tool_calls"}]}'
        ].join("\n\n")
      ));
      controller.close();
    }
  });
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(stream, { status: 200 });
  };
  try {
    const client = createOpenAICompatibleClient({
      baseURL: "http://example.test/v1",
      apiKey: "test",
      model: "test"
    });
    const result = await client.chatStream?.({
      messages: [{ role: "assistant", content: "", reasoningContent: "prior thinking" }],
      tools: [{
        type: "function",
        function: {
          name: "check_feishu",
          parameters: { type: "object" }
        }
      }]
    });
    assert.equal(result?.message.toolCalls?.[0].function.name, "check_feishu");
    assert.equal(result?.message.toolCalls?.[0].function.arguments, "{\"scope\":\"today\"}");
    assert.equal(result?.message.reasoningContent, "think more");
    assert.equal(requestBody.messages[0].reasoning_content, "prior thinking");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("openai stream client preserves include_usage final usage chunk", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: any;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(
        [
          'data: {"id":"chat_1","model":"test","choices":[{"delta":{"content":"answer"}}],"usage":null}',
          'data: {"id":"chat_1","model":"test","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14,"prompt_cache_hit_tokens":6,"prompt_cache_miss_tokens":4}}',
          "data: [DONE]"
        ].join("\n\n")
      ));
      controller.close();
    }
  });
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(stream, { status: 200 });
  };
  try {
    const client = createOpenAICompatibleClient({
      baseURL: "http://example.test/v1",
      apiKey: "test",
      model: "test",
      extraParams: {
        stream_options: {
          include_usage: true
        }
      }
    });
    const result = await client.chatStream?.({ messages: [] });
    assert.equal(requestBody.stream, true);
    assert.deepEqual(requestBody.stream_options, { include_usage: true });
    assert.equal(result?.message.content, "answer");
    assert.deepEqual(result?.usage, {
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
      cacheHitTokens: 6,
      cacheMissTokens: 4
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("openai-compatible client preserves non-stream reasoning content", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    id: "chat_1",
    model: "test",
    choices: [{
      message: {
        role: "assistant",
        content: "answer",
        reasoning_content: "private reasoning"
      },
      finish_reason: "stop"
    }]
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const client = createOpenAICompatibleClient({
      baseURL: "http://example.test/v1",
      apiKey: "test",
      model: "test"
    });
    const result = await client.chat({ messages: [] });
    assert.equal(result.message.content, "answer");
    assert.equal(result.message.reasoningContent, "private reasoning");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("openai-compatible client preserves token usage cache hit stats", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    id: "chat_1",
    model: "test",
    choices: [{
      message: {
        role: "assistant",
        content: "answer"
      },
      finish_reason: "stop"
    }],
    usage: {
      prompt_tokens: 11,
      completion_tokens: 7,
      total_tokens: 18,
      prompt_cache_hit_tokens: 5,
      prompt_cache_miss_tokens: 6
    }
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const client = createOpenAICompatibleClient({
      baseURL: "http://example.test/v1",
      apiKey: "test",
      model: "test"
    });
    const result = await client.chat({ messages: [] });
    assert.deepEqual(result.usage, {
      inputTokens: 11,
      outputTokens: 7,
      totalTokens: 18,
      cacheHitTokens: 5,
      cacheMissTokens: 6
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("openai-compatible client reads OpenAI-style cached token details", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    id: "chat_1",
    model: "test",
    choices: [{
      message: {
        role: "assistant",
        content: "answer"
      },
      finish_reason: "stop"
    }],
    usage: {
      prompt_tokens: 20,
      completion_tokens: 3,
      total_tokens: 23,
      prompt_tokens_details: {
        cached_tokens: 12
      }
    }
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const client = createOpenAICompatibleClient({
      baseURL: "http://example.test/v1",
      apiKey: "test",
      model: "test"
    });
    const result = await client.chat({ messages: [] });
    assert.equal(result.usage?.cacheHitTokens, 12);
    assert.equal(result.usage?.cacheMissTokens, 8);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sqlite store initializes schema version without losing existing logs", () => {
  const dir = makeTempDir("db");
  const dbPath = path.join(dir, "alice.sqlite");
  const store = createAliceStore(dbPath);
  store.insertMessageLog({
    time: "2026-05-24T00:00:00.000Z",
    direction: "inbound",
    plugin: "feishu",
    kind: "text",
    target: "chat",
    sessionId: "session-1",
    rawMessageId: "om_1",
    summary: "hello"
  });

  const reopened = createAliceStore(dbPath);
  assert.equal(reopened.listMessageLogs(10).length, 1);
  assert.equal(reopened.listMessageLogsForSession("session-1", 10)[0].summary, "hello");
  assert.equal(reopened.listUnprocessedInboundForSession("session-1", 10).length, 1);
  const pending = reopened.listPendingInboundSessions();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].sessionId, "session-1");
  reopened.markMessageLogsProcessed([reopened.listMessageLogsForSession("session-1", 10)[0].id], "2026-05-24T00:01:00.000Z", "batch_1");
  assert.equal(reopened.listUnprocessedInboundForSession("session-1", 10).length, 0);

  const db: any = new sqlite.DatabaseSync(dbPath);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 6);
});

test("sqlite migration marks legacy inbound logs processed", () => {
  const dir = makeTempDir("legacy-db");
  const dbPath = path.join(dir, "alice.sqlite");
  const db: any = new sqlite.DatabaseSync(dbPath);
  db.exec(`
    PRAGMA user_version = 2;
    CREATE TABLE message_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      time TEXT NOT NULL,
      direction TEXT NOT NULL,
      plugin TEXT NOT NULL,
      kind TEXT NOT NULL,
      target TEXT,
      session_id TEXT,
      summary TEXT NOT NULL
    );
    INSERT INTO message_logs(time, direction, plugin, kind, target, session_id, summary)
    VALUES ('2026-05-24T00:00:00.000Z', 'inbound', 'feishu', 'text', 'chat', 'session-legacy', 'old');
  `);

  const store = createAliceStore(dbPath);
  assert.equal(store.listUnprocessedInboundForSession("session-legacy", 10).length, 0);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 6);
});

test("sqlite migration backfills message event logs into core-facing messages", () => {
  const dir = makeTempDir("backfill-db");
  const dbPath = path.join(dir, "alice.sqlite");
  const db: any = new sqlite.DatabaseSync(dbPath);
  db.exec(`
    PRAGMA user_version = 4;
    CREATE TABLE message_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      time TEXT NOT NULL,
      direction TEXT NOT NULL,
      plugin TEXT NOT NULL,
      kind TEXT NOT NULL,
      target TEXT,
      session_id TEXT,
      raw_message_id TEXT,
      processed_at TEXT,
      processed_batch_id TEXT,
      summary TEXT NOT NULL,
      external_event_id TEXT,
      parent_raw_message_id TEXT,
      actor_id TEXT,
      status TEXT,
      raw_json TEXT,
      error TEXT
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plugin TEXT NOT NULL,
      external_message_id TEXT,
      conversation_id TEXT NOT NULL,
      direction TEXT NOT NULL,
      sender_id TEXT,
      sender_role TEXT NOT NULL,
      content_type TEXT NOT NULL,
      content_text TEXT NOT NULL,
      content_json TEXT,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL,
      is_read INTEGER NOT NULL DEFAULT 0,
      read_at TEXT,
      is_recalled INTEGER NOT NULL DEFAULT 0,
      recalled_at TEXT,
      reactions_json TEXT NOT NULL DEFAULT '{}',
      last_event_at TEXT NOT NULL,
      core_processed_at TEXT,
      core_batch_id TEXT,
      send_failure_reason TEXT
    );
    INSERT INTO message_logs(time, direction, plugin, kind, target, session_id, raw_message_id, processed_at, processed_batch_id, summary, status)
    VALUES ('2026-05-24T00:00:00.000Z', 'inbound', 'feishu', 'text', 'chat', 'session-backfill', 'om_old', '2026-05-24T00:01:00.000Z', 'legacy', 'old text', 'received');
    INSERT INTO message_logs(time, direction, plugin, kind, raw_message_id, parent_raw_message_id, actor_id, summary, status)
    VALUES ('2026-05-24T00:02:00.000Z', 'inbound', 'feishu', 'reaction.created', 'om_old', 'om_old', 'ou_other', 'reaction.created thumbsup on om_old', 'received');
    INSERT INTO message_logs(time, direction, plugin, kind, raw_message_id, parent_raw_message_id, summary, status)
    VALUES ('2026-05-24T00:03:00.000Z', 'inbound', 'feishu', 'message.read', 'om_old', 'om_old', 'message.read om_old', 'received');
  `);

  const store = createAliceStore(dbPath);
  const message = store.listMessagesForConversation("session-backfill", 10)[0];
  assert.equal(message.externalMessageId, "om_old");
  assert.equal(message.contentText, "old text");
  assert.equal(Boolean(message.isRead), true);
  assert.deepEqual(JSON.parse(message.reactionsJson), { thumbsup: { count: 1, users: ["ou_other"] } });
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 6);
});

test("sqlite store keeps core-facing message state separate from event logs", () => {
  const dir = makeTempDir("messages");
  const store = createAliceStore(path.join(dir, "alice.sqlite"));
  const message = store.upsertInboundMessage({
    plugin: "feishu",
    externalMessageId: "om_1",
    conversationId: "feishu:dm:ou_user",
    senderId: "ou_user",
    contentType: "text",
    contentText: "hello",
    contentJson: JSON.stringify({ text: "hello" }),
    createdAt: "2026-05-24T00:00:00.000Z"
  });

  assert.equal(message.contentText, "hello");
  assert.equal(store.listPendingCoreConversations()[0].conversationId, "feishu:dm:ou_user");
  assert.equal(store.updateMessageReaction({
    plugin: "feishu",
    externalMessageId: "om_1",
    emoji: "thumbsup",
    actorId: "ou_other",
    op: "add",
    at: "2026-05-24T00:01:00.000Z"
  }), true);
  assert.equal(store.markMessageRead("feishu", "om_1", "2026-05-24T00:02:00.000Z"), true);
  assert.equal(store.markMessageRecalled("feishu", "om_1", "2026-05-24T00:03:00.000Z"), true);

  const updated = store.listMessagesForConversation("feishu:dm:ou_user", 10)[0];
  assert.equal(Boolean(updated.isRead), true);
  assert.equal(Boolean(updated.isRecalled), true);
  assert.deepEqual(JSON.parse(updated.reactionsJson), { thumbsup: { count: 1, users: ["ou_other"] } });
});

function namedClient(name: string): LLMClient {
  return {
    async chat() {
      return { message: { role: "assistant", content: name } };
    },
    async listModels() {
      return [{ id: name }];
    }
  };
}

function makeTempDir(name: string): string {
  const dir = path.join("/tmp", `alice-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
