import { test } from "node:test";
import assert from "node:assert/strict";
import { createMutableLLMClient, createOpenAICompatibleClient, type LLMClient } from "../core/llm/src/index.js";
import { createLLMRequests } from "../apps/api/src/llm-requests.js";
import { acquireSingletonLock } from "../apps/api/src/singleton-lock.js";
import { createCurrentTimeProvider } from "../core/time/src/index.js";
import { createAliceStore } from "../packages/storage/src/sqlite-store.js";
import { createTokenUsageStore } from "../packages/storage/src/token-usage-store.js";
import * as sqlite from "../packages/storage/src/sqlite-compat.js";

const fs = await import("node:fs");
const path = await import("node:path");

test("mutable LLM client delegates to the latest configured client", async () => {
  const first = namedClient("first");
  const second = namedClient("second");
  const client = createMutableLLMClient(first);

  assert.equal((await client.chat({ messages: [] })).message.content, "first");
  client.setClient(second);
  assert.equal((await client.chat({ messages: [] })).message.content, "second");
  assert.deepEqual(await client.listModels?.(), [{ id: "second" }]);
});

test("singleton lock rejects another running process in the same memory root", () => {
  const root = makeTempDir("singleton-lock");
  const first = acquireSingletonLock(root, "api");
  try {
    assert.throws(() => acquireSingletonLock(root, "api"), /service_already_running/);
  } finally {
    first.release();
  }
  const second = acquireSingletonLock(root, "api");
  second.release();
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
          'data: {"id":"chat_1","model":"test","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"check_chat","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}'
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
          name: "check_chat",
          parameters: { type: "object" }
        }
      }]
    });
    assert.equal(result?.message.toolCalls?.[0].function.name, "check_chat");
    assert.equal(result?.message.toolCalls?.[0].function.arguments, "{}");
    assert.equal(result?.message.reasoningContent, "think more");
    assert.equal(requestBody.messages[0].reasoning_content, "prior thinking");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("openai stream client cancels failed streams before retry can continue", async () => {
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: {not json}\n\n"));
    },
    cancel() {
      cancelled = true;
    }
  });
  globalThis.fetch = async () => new Response(stream, { status: 200 });
  try {
    const client = createOpenAICompatibleClient({
      baseURL: "http://example.test/v1",
      apiKey: "test",
      model: "test"
    });
    assert.ok(client.chatStream);
    await assert.rejects(() => client.chatStream!({ messages: [] }));
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("openai stream client cancels when reader.read throws", async () => {
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = async () => ({
    ok: true,
    body: {
      getReader() {
        return {
          async read() {
            throw new Error("read failed");
          },
          async cancel() {
            cancelled = true;
          }
        };
      }
    }
  }) as unknown as Response;
  try {
    const client = createOpenAICompatibleClient({
      baseURL: "http://example.test/v1",
      apiKey: "test",
      model: "test"
    });
    assert.ok(client.chatStream);
    await assert.rejects(() => client.chatStream!({ messages: [] }), /read failed/);
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("openai stream client aborts requests at timeout", async () => {
  const originalFetch = globalThis.fetch;
  let aborted = false;
  globalThis.fetch = (_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      aborted = true;
      reject(new DOMException("aborted", "AbortError"));
    });
  });
  try {
    const client = createOpenAICompatibleClient({
      baseURL: "http://example.test/v1",
      apiKey: "test",
      model: "test",
      timeoutMs: 1
    });
    assert.ok(client.chatStream);
    await assert.rejects(() => client.chatStream!({ messages: [] }), /aborted|AbortError/);
    assert.equal(aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("openai-compatible client adds fallback reasoning content for tool request messages", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: any;
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "ok" } }]
    }), { status: 200 });
  };
  try {
    const client = createOpenAICompatibleClient({
      baseURL: "http://example.test/v1",
      apiKey: "test",
      model: "test"
    });
    await client.chat({
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "call_missing",
            type: "function",
            function: {
              name: "check_chat",
              arguments: "{}"
            }
          }]
        },
        {
          role: "assistant",
          content: "",
          reasoningContent: "original thinking",
          toolCalls: [{
            id: "call_original",
            type: "function",
            function: {
              name: "search_messages",
              arguments: "{\"content\":\"x\"}"
            }
          }]
        }
      ]
    });
    assert.equal(requestBody.messages[0].reasoning_content, "Need to call the requested tool.");
    assert.equal(requestBody.messages[1].reasoning_content, "original thinking");
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

test("openai-compatible client lets request extra params replace default extra params", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: any;
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "ok" } }]
    }), { status: 200 });
  };
  try {
    const client = createOpenAICompatibleClient({
      baseURL: "http://example.test/v1",
      apiKey: "test",
      model: "test",
      extraParams: {
        cache_prompt: true,
        stream_options: { include_usage: true }
      }
    });
    await client.chat({
      messages: [],
      extraParams: {
        cache_prompt: false
      }
    });
    assert.equal(requestBody.cache_prompt, false);
    assert.equal(requestBody.stream_options, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("openai-compatible client preserves preset max_tokens extra param when request omits maxTokens", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: any;
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "ok" } }]
    }), { status: 200 });
  };
  try {
    const client = createOpenAICompatibleClient({
      baseURL: "http://example.test/v1",
      apiKey: "test",
      model: "test",
      extraParams: {
        max_tokens: 123
      }
    });
    await client.chat({ messages: [] });
    assert.equal(requestBody.max_tokens, 123);
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

test("token usage store records events and aggregates cache hit rate by hour", () => {
  const dir = makeTempDir("token-usage");
  const store = createTokenUsageStore(path.join(dir, "logs", "token_usage", "token-usage.sqlite"));
  store.insert({
    createdAt: "2026-05-30T10:05:00.000",
    agentId: "core",
    model: "deepseek-chat",
    sessionId: 1,
    requestId: 1,
    responseId: 1,
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    cacheHitTokens: 60,
    cacheMissTokens: 40,
    rawUsageJson: "{\"prompt_tokens\":100}"
  });
  store.insert({
    createdAt: "2026-05-30T10:35:00.000",
    agentId: "core",
    model: "deepseek-chat",
    inputTokens: 50,
    outputTokens: 10,
    totalTokens: 60,
    cacheHitTokens: 25
  });
  store.insert({
    createdAt: "2026-05-30T11:00:00.000",
    agentId: "side",
    model: "other",
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15
  });

  const report = store.report({
    since: "2026-05-30T10:00:00.000",
    bucket: "hour",
    agentId: "core",
    model: "deepseek-chat"
  });
  assert.equal(report.summary.requests, 2);
  assert.equal(report.summary.totalTokens, 180);
  assert.equal(report.summary.cacheHitTokens, 85);
  assert.equal(report.summary.cacheMissTokens, 40);
  assert.equal(Math.round((report.summary.cacheHitRate ?? 0) * 1000) / 1000, 0.68);
  assert.deepEqual(report.buckets.map((bucket) => bucket.bucket), ["2026-05-30T10:00"]);
  assert.equal(report.byModel[0].model, "deepseek-chat");
  assert.equal(report.latest.length, 2);
});

test("token usage store aggregates by day and keeps unknown usage rows", () => {
  const dir = makeTempDir("token-usage-empty");
  const store = createTokenUsageStore(path.join(dir, "token-usage.sqlite"));
  store.insert({
    createdAt: "2026-05-29T23:59:00.000",
    agentId: "core",
    model: "unknown-usage",
    finishReason: "stop"
  });
  store.insert({
    createdAt: "2026-05-30T00:01:00.000",
    agentId: "core",
    model: "unknown-usage",
    outputTokens: 3
  });

  const report = store.report({ bucket: "day" });
  assert.deepEqual(report.buckets.map((bucket) => bucket.bucket), ["2026-05-29", "2026-05-30"]);
  assert.equal(report.summary.requests, 2);
  assert.equal(report.summary.outputTokens, 3);
  assert.equal(report.summary.cacheHitRate, undefined);
  assert.equal(report.latest[0].model, "unknown-usage");
});

test("LLMRequests builds tools by name with stable order and rejects unknown tools", async () => {
  const requests = createLLMRequests({
    getTool(name) {
      return {
        first: { name: "first", description: "First {{name}}", inputSchema: { type: "object", properties: { a: { const: "{{value}}" } } } },
        second: { name: "second", description: "Second", inputSchema: { type: "object" } }
      }[name];
    }
  });

  const tools = requests.buildTools(["second", "first", "second"], { name: "tool", value: "v" });
  assert.deepEqual(tools.map((tool) => tool.function.name), ["second", "first"]);
  assert.equal(tools[1].function.description, "First tool");
  assert.deepEqual(tools[1].function.parameters?.properties, { a: { const: "v" } });
  assert.throws(() => requests.buildTools(["missing"]), /unknown LLM tool: missing/);
});

test("LLMRequests records memorize token usage through response hook", async () => {
  const dir = makeTempDir("llm-requests-usage");
  const store = createTokenUsageStore(path.join(dir, "token-usage.sqlite"));
  const client: LLMClient = {
    async chat(input) {
      return {
        model: input.model,
        message: { role: "assistant", content: "done" },
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, cacheHitTokens: 4, cacheMissTokens: 6 },
        raw: { usage: { prompt_tokens: 10 } }
      };
    }
  };
  const requests = createLLMRequests({
    getTool(name) {
      return name === "read_memory" ? { name, description: "read", inputSchema: { type: "object" } } : undefined;
    },
    onResponseReceived(input, request, result) {
      store.insert({
        createdAt: "2026-05-30T10:00:00.000",
        agentId: input.agentId,
        model: result.model ?? request.model,
        inputTokens: result.usage?.inputTokens,
        outputTokens: result.usage?.outputTokens,
        totalTokens: result.usage?.totalTokens,
        cacheHitTokens: result.usage?.cacheHitTokens,
        cacheMissTokens: result.usage?.cacheMissTokens
      });
    },
    retryDelayMs: () => 0,
    sleep: async () => {}
  });

  await requests.send({
    agentId: "memorize",
    client,
    messages: [],
    model: "memorize-model",
    toolNames: ["read_memory"],
    round: 0
  });

  const report = store.report({ agentId: "memorize" });
  assert.equal(report.summary.requests, 1);
  assert.equal(report.summary.totalTokens, 12);
  assert.equal(report.byModel[0].model, "memorize-model");
});

test("LLMRequests does not retry a successful call when response hook fails", async () => {
  let calls = 0;
  const client: LLMClient = {
    async chat() {
      calls += 1;
      return { message: { role: "assistant", content: "done" }, finishReason: "stop" };
    }
  };
  const requests = createLLMRequests({
    getTool() {
      return undefined;
    },
    onResponseReceived() {
      throw new Error("503 observer failed after success");
    },
    retryDelayMs: () => 0,
    sleep: async () => {}
  });

  await assert.rejects(() => requests.send({
    agentId: "memorize",
    client,
    messages: [],
    model: "memorize-model",
    toolNames: [],
    round: 0
  }), /observer failed/);
  assert.equal(calls, 1);
});

test("LLMRequests cancels the active request signal", async () => {
  let signal: AbortSignal | undefined;
  let responseHookCalls = 0;
  const client: LLMClient = {
    chat(input) {
      signal = input.signal;
      return new Promise((resolve, reject) => {
        input.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        setTimeout(() => resolve({ message: { role: "assistant", content: "late" } }), 50);
      });
    }
  };
  const requests = createLLMRequests({
    getTool() {
      return undefined;
    },
    onResponseReceived() {
      responseHookCalls += 1;
    },
    retryDelayMs: () => 0,
    sleep: async () => {}
  });

  const pending = requests.send({
    agentId: "core",
    client,
    messages: [],
    model: "core-model",
    toolNames: [],
    round: 0
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(requests.cancelActive(), true);
  await assert.rejects(() => pending, /llm_request_cancelled/);
  assert.equal(signal?.aborted, true);
  assert.equal(responseHookCalls, 0);
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
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 7);
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
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 7);
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
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 7);
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
  assert.deepEqual(store.listPendingCoreConversations(), []);
  assert.deepEqual(store.listUnprocessedCoreMessagesForConversation("feishu:dm:ou_user", 10), []);
  store.markMessagesReadAndCoreProcessed([message.id], "2026-05-24T00:04:00.000Z", "check_read_later");
  assert.equal(store.markMessageRecalled("feishu", "om_1", "2026-05-24T00:03:00.000Z"), true);

  const updated = store.listMessagesForConversation("feishu:dm:ou_user", 10)[0];
  assert.equal(Boolean(updated.isRead), true);
  assert.equal(updated.readAt, "2026-05-24T00:02:00.000");
  assert.equal(Boolean(updated.isRecalled), true);
  assert.deepEqual(JSON.parse(updated.reactionsJson), { thumbsup: { count: 1, users: ["ou_other"] } });
});

test("sqlite store lists messages chronologically and by created range", () => {
  const dir = makeTempDir("message-range");
  const store = createAliceStore(path.join(dir, "alice.sqlite"));
  store.upsertInboundMessage({
    plugin: "feishu",
    externalMessageId: "om_1",
    conversationId: "session",
    contentType: "text",
    contentText: "one",
    createdAt: "2026-05-24T00:00:00.000Z"
  });
  store.insertOutboundMessage({
    plugin: "feishu",
    conversationId: "session",
    contentType: "text",
    contentText: "two",
    createdAt: "2026-05-24T01:00:00.000Z"
  });
  store.upsertInboundMessage({
    plugin: "feishu",
    externalMessageId: "om_3",
    conversationId: "session",
    contentType: "text",
    contentText: "three",
    createdAt: "2026-05-24T07:00:00.000Z"
  });

  assert.deepEqual(store.listMessagesChronological().map((message) => message.contentText), ["one", "two", "three"]);
  assert.deepEqual(
    store.listMessagesByCreatedAtRange("2026-05-24T00:30:00.000Z", "2026-05-24T07:00:00.000Z").map((message) => message.contentText),
    ["two"]
  );
  assert.deepEqual(
    store.listMessagesByCreatedAtRange("2026-05-24T00:00:00.000Z", "2026-05-24T01:00:00.000Z").map((message) => message.contentText),
    ["one"]
  );
});

test("sqlite store writes UTC source times and derives configured timezone fields", () => {
  const dir = makeTempDir("message-utc-source");
  const store = createAliceStore(path.join(dir, "alice.sqlite"), {
    time: createCurrentTimeProvider("Asia/Shanghai")
  });
  const log = store.insertMessageLog({
    time: "ignored-local",
    timeUtc: "2026-06-02T15:26:34.819Z",
    direction: "inbound",
    plugin: "feishu",
    kind: "text",
    summary: "hello"
  });
  assert.equal(log.timeUtc, "2026-06-02T15:26:34.819Z");
  assert.equal(log.time, "2026-06-02T23:26:34.819");

  const inbound = store.upsertInboundMessage({
    plugin: "feishu",
    externalMessageId: "om_utc",
    conversationId: "session",
    contentType: "text",
    contentText: "one",
    createdAt: "ignored-local",
    createdAtUtc: "2026-06-02T15:26:34.819Z"
  });
  assert.equal(inbound.createdAtUtc, "2026-06-02T15:26:34.819Z");
  assert.equal(inbound.createdAt, "2026-06-02T23:26:34.819");

  const outbound = store.insertOutboundMessage({
    plugin: "feishu",
    conversationId: "session",
    contentType: "text",
    contentText: "two",
    createdAt: "ignored-local",
    createdAtUtc: "2026-06-02T15:29:58.129Z"
  });
  store.markOutboundMessageSent(outbound.id, "om_sent", "2026-06-02T15:29:59.326Z", "2026-06-02T15:29:58.129Z");
  const sent = store.listMessagesForConversation("session", 10).find((message) => message.id === outbound.id);
  assert.equal(sent?.createdAtUtc, "2026-06-02T15:29:58.129Z");
  assert.equal(sent?.createdAt, "2026-06-02T23:29:58.129");
  assert.equal(sent?.lastEventAtUtc, "2026-06-02T15:29:59.326Z");
  assert.equal(sent?.lastEventAt, "2026-06-02T23:29:59.326");
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
