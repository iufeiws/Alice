import { test } from "node:test";
import assert from "node:assert/strict";
import { createAliceStore } from "../../../src/contexts/conversation-hub/src/adapters/sqlite-conversation-store.js";
import { createTokenUsageStore } from "../../../src/platform/storage/src/token-usage-store.js";
import { createModelPriceSync } from "../../../src/contexts/llm-gateway/src/model-price-sync.js";
import { createCurrentTimeProvider } from "../../../src/platform/time/src/index.js";
import * as sqlite from "../../../src/platform/storage/src/sqlite-compat.js";
import { path, makeTempDir } from "./llm-and-storage-helpers.js";

test("token usage store aggregates cache hit rate by hour", () => {
  const dir = makeTempDir("token-usage");
  const store = createTokenUsageStore(path.join(dir, "logs", "token_usage", "token-usage.sqlite"));
  store.insert({
    createdAt: "2026-05-30T10:05:00.000",
    agentId: "chat",
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
    agentId: "chat",
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
    agentId: "chat",
    model: "deepseek-chat"
  });
  assert.equal(report.summary.requests, 2);
  assert.equal(report.summary.totalTokens, 180);
  assert.equal(report.summary.cacheHitTokens, 85);
  assert.equal(report.summary.cacheMissTokens, 40);
  assert.equal(Math.round((report.summary.cacheHitRate ?? 0) * 1000) / 1000, 0.68);
  assert.deepEqual(report.buckets.map((bucket) => bucket.bucket), ["2026-05-30T10:00"]);
});

test("token usage store aggregates by day", () => {
  const dir = makeTempDir("token-usage-empty");
  const store = createTokenUsageStore(path.join(dir, "token-usage.sqlite"));
  store.insert({
    createdAt: "2026-05-29T23:59:00.000",
    agentId: "chat",
    model: "unknown-usage",
    finishReason: "stop"
  });
  store.insert({
    createdAt: "2026-05-30T00:01:00.000",
    agentId: "chat",
    model: "unknown-usage",
    outputTokens: 3
  });

  const report = store.report({ bucket: "day" });
  assert.deepEqual(report.buckets.map((bucket) => bucket.bucket), ["2026-05-29", "2026-05-30"]);
});

test("token usage store keeps unknown usage rows", () => {
  const dir = makeTempDir("token-usage-unknown");
  const store = createTokenUsageStore(path.join(dir, "token-usage.sqlite"));
  store.insert({
    createdAt: "2026-05-29T23:59:00.000",
    agentId: "chat",
    model: "unknown-usage",
    finishReason: "stop"
  });
  store.insert({
    createdAt: "2026-05-30T00:01:00.000",
    agentId: "chat",
    model: "unknown-usage",
    outputTokens: 3
  });

  const report = store.report({ bucket: "day" });
  assert.equal(report.summary.requests, 2);
  assert.equal(report.summary.outputTokens, 3);
  assert.equal(report.summary.cacheHitRate, undefined);
  assert.equal(report.latest[0].model, "unknown-usage");
});

test("token usage store merges identical price bundles and ignores terminal v1 when finding a provider", () => {
  const dir = makeTempDir("token-usage-price-catalog");
  const store = createTokenUsageStore(path.join(dir, "token-usage.sqlite"));
  const price = { input: 2, output: 8, cache_read: 0.2, cache_write: 2.5 };
  const catalog = {
    providers: [{ providerId: "openai", apiURL: "https://api.openai.com/v1" }],
    models: [{ providerId: "openai", modelId: "gpt-test", price }]
  };
  store.replaceModelCatalog(catalog, "2026-05-30T10:00:00.000Z");
  store.replaceModelCatalog(catalog, "2026-05-30T10:30:00.000Z");

  const matched = store.recordModelPrice({ baseURL: "https://api.openai.com/v1/", model: "gpt-test", observedAtUtc: "2026-05-30T10:30:00.000Z" });
  assert.equal(matched?.providerId, "openai");
  assert.deepEqual(matched?.price, price);
  assert.equal(store.catalogNeedsRefresh("2026-05-30T10:59:59.999Z", 60 * 60 * 1000), false);
  assert.equal(store.catalogNeedsRefresh("2026-05-30T11:30:00.000Z", 60 * 60 * 1000), true);
});

test("model price sync persists the complete catalog and fetches it at most once per hour", async () => {
  const dir = makeTempDir("token-usage-price-sync");
  const store = createTokenUsageStore(path.join(dir, "token-usage.sqlite"));
  let now = new Date("2026-05-30T10:00:00.000Z");
  let fetches = 0;
  const sync = createModelPriceSync({
    store,
    now: () => now,
    fetch: async () => {
      fetches += 1;
      return new Response(JSON.stringify({
        neon: { api: "${NEON_AI_GATEWAY_BASE_URL}/v1", models: { ignored: { cost: { input: 1, output: 1 } } } },
        local: { models: { "unpriced-model": {} } },
        openai: { api: "https://api.openai.com/v1", models: {
          "gpt-test": { cost: { input: 2, output: 8, cache_read: 0.2 } },
          "mimo-v2.5": { cost: { input: 0.14, output: 0.28, cache_read: 0.0028 } }
        } },
        anthropic: { api: "https://api.anthropic.com/v1", models: {
          "claude-test": { cost: { input: 3, output: 15 } }
        } }
      }));
    }
  });
  const preset = { baseURL: "https://api.openai.com", model: "gpt-test" };

  assert.equal((await sync.resolvePrice(preset))?.price.output, 8);
  assert.deepEqual(store.getModelCatalogStats(), { providers: 4, models: 5, pricedModels: 4 });
  assert.equal((await sync.resolvePrice({ ...preset, model: "mimo-v2.5" }))?.price.output, 0.28);
  assert.equal((await sync.resolvePrice({ baseURL: "https://api.anthropic.com/v1", model: "claude-test" }))?.price.output, 15);
  assert.equal(fetches, 1);
  now = new Date("2026-05-30T10:30:00.000Z");
  await sync.resolvePrice(preset);
  now = new Date("2026-05-30T11:00:00.000Z");
  await sync.resolvePrice(preset);
  assert.equal(fetches, 2);
});

test("model price sync warns and selects the first upstream provider when URL and model are duplicated", async () => {
  const dir = makeTempDir("token-usage-duplicate-provider");
  const store = createTokenUsageStore(path.join(dir, "token-usage.sqlite"));
  store.replaceModelCatalog({
    providers: [
      { providerId: "first", apiURL: "https://api.example.test/v1" },
      { providerId: "second", apiURL: "https://api.example.test/v1" }
    ],
    models: [
      { providerId: "first", modelId: "shared", price: { input: 1, output: 2 } },
      { providerId: "second", modelId: "shared", price: { input: 3, output: 6 } }
    ]
  }, "2026-05-30T10:00:00.000Z");
  const warnings: string[] = [];
  const sync = createModelPriceSync({
    store,
    now: () => new Date("2026-05-30T10:30:00.000Z"),
    appendLog: (_level, message) => warnings.push(message)
  });

  const price = await sync.resolvePrice({ baseURL: "https://api.example.test/v1", model: "shared" });

  assert.equal(price?.providerId, "first");
  assert.deepEqual(price?.price, { input: 1, output: 2 });
  assert.deepEqual(warnings, [
    "model price provider match is ambiguous: base_url=https://api.example.test model=shared providers=first,second selected=first"
  ]);
});

test("model catalog expiry is checked for every usage even when that event has no price match context", async () => {
  const dir = makeTempDir("token-usage-catalog-without-price-context");
  const store = createTokenUsageStore(path.join(dir, "token-usage.sqlite"));
  let fetches = 0;
  const sync = createModelPriceSync({
    store,
    now: () => new Date("2026-05-30T10:00:00.000Z"),
    fetch: async () => {
      fetches += 1;
      return new Response(JSON.stringify({ local: { models: { unpriced: {} } } }));
    }
  });

  assert.equal(await sync.resolvePrice(undefined), undefined);
  assert.equal(fetches, 1);
  assert.deepEqual(store.getModelCatalogStats(), { providers: 1, models: 1, pricedModels: 0 });
});

test("token usage report calculates each latest event from its historical price snapshot", () => {
  const dir = makeTempDir("token-usage-latest-price");
  const store = createTokenUsageStore(path.join(dir, "token-usage.sqlite"));
  store.replaceModelCatalog({
    providers: [{ providerId: "openai", apiURL: "https://api.openai.com/v1" }],
    models: [{ providerId: "openai", modelId: "gpt-test", price: { input: 2, output: 8, cache_read: 0.2 } }]
  }, "2026-05-30T10:00:00.000Z");
  const price = store.recordModelPrice({ baseURL: "https://api.openai.com/v1", model: "gpt-test", observedAtUtc: "2026-05-30T10:00:00.000Z" });
  store.insert({
    createdAt: "2026-05-30T10:05:00.000",
    createdAtUtc: "2026-05-30T10:05:00.000Z",
    agentId: "image_recognition",
    model: "gpt-test",
    providerId: price?.providerId,
    inputTokens: 100,
    outputTokens: 10,
    cacheHitTokens: 20,
    cacheMissTokens: 80
  });

  const report = store.report();
  assert.equal(report.latest[0].costUsd, 0.000244);
  assert.equal(report.summary.costUsd, 0.000244);
});

test("token usage report matches each call to the price trajectory already observed for that provider and model", () => {
  const dir = makeTempDir("token-usage-price-trajectory");
  const store = createTokenUsageStore(path.join(dir, "token-usage.sqlite"));
  const provider = [{ providerId: "openai", apiURL: "https://api.openai.com/v1" }];
  store.replaceModelCatalog({
    providers: provider,
    models: [{ providerId: "openai", modelId: "gpt-test", price: { input: 1, output: 2 } }]
  }, "2026-05-30T10:00:00.000Z");
  store.recordModelPrice({ baseURL: "https://api.openai.com/v1", model: "gpt-test", observedAtUtc: "2026-05-30T10:00:00.000Z" });
  store.insert({
    createdAt: "2026-05-30T10:05:00.000",
    createdAtUtc: "2026-05-30T10:05:00.000Z",
    agentId: "chat",
    providerId: "openai",
    model: "gpt-test",
    inputTokens: 1_000_000,
    outputTokens: 1_000_000
  });

  store.replaceModelCatalog({
    providers: provider,
    models: [{ providerId: "openai", modelId: "gpt-test", price: { input: 3, output: 6 } }]
  }, "2026-05-30T11:00:00.000Z");
  store.recordModelPrice({ baseURL: "https://api.openai.com/v1", model: "gpt-test", observedAtUtc: "2026-05-30T11:00:00.000Z" });
  store.insert({
    createdAt: "2026-05-30T11:05:00.000",
    createdAtUtc: "2026-05-30T11:05:00.000Z",
    agentId: "chat",
    providerId: "openai",
    model: "gpt-test",
    inputTokens: 1_000_000,
    outputTokens: 1_000_000
  });

  const latest = store.report().latest;
  assert.deepEqual(latest.map((event) => event.costUsd), [9, 3]);
});

test("catalog replacement does not create price history for models that were never called", () => {
  const dir = makeTempDir("token-usage-on-demand-price-history");
  const store = createTokenUsageStore(path.join(dir, "token-usage.sqlite"));
  store.replaceModelCatalog({
    providers: [{ providerId: "provider", apiURL: "https://api.example.test/v1" }],
    models: [
      { providerId: "provider", modelId: "called", price: { input: 1, output: 2 } },
      { providerId: "provider", modelId: "never-called", price: { input: 10, output: 20 } }
    ]
  }, "2026-05-30T10:00:00.000Z");
  store.recordModelPrice({ baseURL: "https://api.example.test/v1", model: "called", observedAtUtc: "2026-05-30T10:00:00.000Z" });
  store.insert({
    createdAt: "2026-05-30T10:01:00.000",
    createdAtUtc: "2026-05-30T10:01:00.000Z",
    agentId: "chat",
    providerId: "provider",
    model: "never-called",
    inputTokens: 1_000_000,
    outputTokens: 1_000_000
  });

  assert.equal(store.report().latest[0].costUsd, undefined);
});

test("complete catalog replacement removes models missing from the next upstream table", () => {
  const dir = makeTempDir("token-usage-catalog-replacement");
  const store = createTokenUsageStore(path.join(dir, "token-usage.sqlite"));
  store.replaceModelCatalog({
    providers: [
      { providerId: "first", apiURL: "https://first.example.test/v1" },
      { providerId: "removed", apiURL: "https://removed.example.test/v1" }
    ],
    models: [
      { providerId: "first", modelId: "kept", price: { input: 1, output: 2 } },
      { providerId: "removed", modelId: "gone", price: { input: 3, output: 6 } }
    ]
  }, "2026-05-30T10:00:00.000Z");

  const stats = store.replaceModelCatalog({
    providers: [{ providerId: "first", apiURL: "https://first.example.test/v1" }],
    models: [{ providerId: "first", modelId: "kept", price: { input: 1, output: 2 } }]
  }, "2026-05-30T11:00:00.000Z");

  assert.deepEqual(stats, { providers: 1, models: 1, pricedModels: 1 });
  assert.equal(store.recordModelPrice({ baseURL: "https://removed.example.test/v1", model: "gone", observedAtUtc: "2026-05-30T11:01:00.000Z" }), undefined);
});

test("opening the legacy price schema expires its incomplete catalog without losing usage price history", () => {
  const dir = makeTempDir("token-usage-price-schema-migration");
  const dbPath = path.join(dir, "token-usage.sqlite");
  const legacy: any = new sqlite.DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE token_usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, created_at_utc TEXT,
      agent_id TEXT NOT NULL, model TEXT, session_id INTEGER, request_id INTEGER, response_id INTEGER,
      input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER, cache_hit_tokens INTEGER,
      cache_miss_tokens INTEGER, cache_hit_rate REAL, finish_reason TEXT, raw_usage_json TEXT, provider_id TEXT
    );
    CREATE TABLE llm_model_catalog_sync (source TEXT PRIMARY KEY, updated_at_utc TEXT NOT NULL);
    CREATE TABLE llm_model_price_timeline (
      id INTEGER PRIMARY KEY AUTOINCREMENT, provider_id TEXT NOT NULL, model_id TEXT NOT NULL,
      price_json TEXT NOT NULL, input_per_mtok REAL NOT NULL, output_per_mtok REAL NOT NULL,
      cache_read_per_mtok REAL, cache_write_per_mtok REAL, first_seen_at_utc TEXT NOT NULL, last_seen_at_utc TEXT NOT NULL
    );
    INSERT INTO llm_model_catalog_sync VALUES ('models.dev', '2026-05-30T10:30:00.000Z');
    INSERT INTO llm_model_price_timeline VALUES (1, 'provider', 'model', '{"input":1,"output":2}', 1, 2, NULL, NULL, '2026-05-30T10:00:00.000Z', '2026-05-30T10:00:00.000Z');
    INSERT INTO token_usage_events(created_at, created_at_utc, agent_id, provider_id, model, input_tokens, output_tokens)
      VALUES ('2026-05-30T10:05:00.000', '2026-05-30T10:05:00.000Z', 'chat', 'provider', 'model', 1000000, 1000000);
  `);
  legacy.close();

  const store = createTokenUsageStore(dbPath);

  assert.equal(store.catalogNeedsRefresh("2026-05-30T10:31:00.000Z", 60 * 60 * 1000), true);
  assert.equal(store.report().latest[0].costUsd, 3);
});

test("sqlite store preserves existing message logs after schema initialization", () => {
  const { reopened } = createStoreWithInboundLog("db-preserve-logs");
  assert.equal(reopened.listMessageLogs(10).length, 1);
  assert.equal(reopened.listMessageLogsForSession("session-1", 10)[0].summary, "hello");
});

test("sqlite store lists pending inbound sessions after schema initialization", () => {
  const { reopened } = createStoreWithInboundLog("db-pending-inbound");
  assert.equal(reopened.listUnprocessedInboundForSession("session-1", 10).length, 1);
  const pending = reopened.listPendingInboundSessions();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].sessionId, "session-1");
});

test("sqlite store marks initialized inbound logs processed", () => {
  const { reopened } = createStoreWithInboundLog("db-processed-inbound");
  reopened.markMessageLogsProcessed([reopened.listMessageLogsForSession("session-1", 10)[0].id], "2026-05-24T00:01:00.000Z", "batch_1");
  assert.equal(reopened.listUnprocessedInboundForSession("session-1", 10).length, 0);
});

test("sqlite store initializes schema version", () => {
  const { dbPath } = createStoreWithInboundLog("db-schema-version");
  const db: any = new sqlite.DatabaseSync(dbPath);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 10);
});

test("sqlite store inserts inbound core-facing message state", () => {
  const { message } = createCoreMessageStore("messages-inbound");
  assert.equal(message.contentText, "hello");
});

test("sqlite store inserts outbound core-facing message state", () => {
  const { store } = createCoreMessageStore("messages-outbound");
  const outbound = store.insertOutboundMessage({
    plugin: "feishu",
    conversationId: "feishu:dm:ou_user",
    senderName: "shell",
    contentType: "text",
    contentText: "from shell",
    createdAt: "2026-05-24T00:01:00.000Z"
  });
  assert.equal(outbound.senderName, "shell");
});

test("sqlite store clears pending core conversation after message read", () => {
  const { store, message } = createCoreMessageStore("messages-pending");
  assert.equal(store.listPendingCoreConversations()[0].conversationId, "feishu:dm:ou_user");
  store.markMessagesReadAndCoreProcessed([message.id], "2026-05-24T00:04:00.000Z", "check_read_later");
  assert.deepEqual(store.listPendingCoreConversations(), []);
  assert.deepEqual(store.listUnprocessedCoreMessagesForConversation("feishu:dm:ou_user", 10), []);
});

test("sqlite store updates core-facing message reactions", () => {
  const { store } = createCoreMessageStore("messages-reaction");
  assert.equal(store.updateMessageReaction({
    plugin: "feishu",
    externalMessageId: "om_1",
    emoji: "thumbsup",
    actorId: "ou_other",
    op: "add",
    at: "2026-05-24T00:01:00.000Z"
  }), true);

  const updated = store.listMessagesForConversation("feishu:dm:ou_user", 10)[0];
  assert.deepEqual(JSON.parse(updated.reactionsJson), { thumbsup: { count: 1, users: ["ou_other"] } });
});

test("sqlite store updates core-facing message read state", () => {
  const { store } = createCoreMessageStore("messages-read");
  assert.equal(store.markMessageRead("feishu", "om_1", "2026-05-24T00:02:00.000Z"), true);

  const updated = store.listMessagesForConversation("feishu:dm:ou_user", 10)[0];
  assert.equal(Boolean(updated.isRead), true);
  assert.equal(updated.readAt, "2026-05-24T00:02:00.000");
});

test("sqlite store updates core-facing message recalled state", () => {
  const { store } = createCoreMessageStore("messages-recall");
  assert.equal(store.markMessageRecalled("feishu", "om_1", "2026-05-24T00:03:00.000Z"), true);

  const updated = store.listMessagesForConversation("feishu:dm:ou_user", 10)[0];
  assert.equal(Boolean(updated.isRecalled), true);
});

function createCoreMessageStore(name: string) {
  const dir = makeTempDir(name);
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
  return { store, message };
}

test("sqlite store lists messages chronologically", () => {
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
});

test("sqlite store lists messages by created range", () => {
  const dir = makeTempDir("message-created-range");
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

  assert.deepEqual(
    store.listMessagesByCreatedAtRange("2026-05-24T00:30:00.000Z", "2026-05-24T07:00:00.000Z").map((message) => message.contentText),
    ["two"]
  );
  assert.deepEqual(
    store.listMessagesByCreatedAtRange("2026-05-24T00:00:00.000Z", "2026-05-24T01:00:00.000Z").map((message) => message.contentText),
    ["one"]
  );
});

test("sqlite store derives local message log time from UTC source time", () => {
  const store = createUtcSourceStore("message-log-utc-source");
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
});

test("sqlite store derives local inbound message time from UTC source time", () => {
  const store = createUtcSourceStore("inbound-utc-source");
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
});

test("sqlite store derives local outbound sent time from UTC source time", () => {
  const store = createUtcSourceStore("outbound-utc-source");
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

function createUtcSourceStore(name: string) {
  const dir = makeTempDir(name);
  return createAliceStore(path.join(dir, "alice.sqlite"), {
    time: createCurrentTimeProvider("Asia/Shanghai")
  });
}

function createStoreWithInboundLog(name: string) {
  const dir = makeTempDir(name);
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
  return { dbPath, reopened: createAliceStore(dbPath) };
}
