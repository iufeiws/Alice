import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertCardRecord,
  assertCreatedCard,
  assertStreamState,
  assertUpdateIncludes,
  CARD_LAYOUT_VERSION,
  createTestFeishuIndicator,
  fakeCardClient,
  fixedNow,
  memoryCardStore,
  pairedStore,
  waitFor
} from "./agent-run-indicator-helpers.js";

test("Feishu agent run indicator creates a card on begin", async () => {
  const store = memoryCardStore();
  const client = fakeCardClient();
  const indicator = createTestFeishuIndicator({
    client,
    cardStore: store,
    throttleMs: 10_000,
    getState: () => ({ state: "working" })
  });

  const session = await indicator.begin({ round: 0 });
  assert.ok(session);

  assertCreatedCard(client, { state: "正在输入中...", reasoning: "", content: "", tools: "" });
});

test("Feishu agent run indicator streams and flushes final content", async () => {
  const store = memoryCardStore();
  const client = fakeCardClient();
  const indicator = createTestFeishuIndicator({
    client,
    cardStore: store,
    throttleMs: 10_000,
    getState: () => ({ state: "working" })
  });

  const session = await indicator.begin({ round: 0 });
  assert.ok(session);
  await session.appendContentDelta("he");
  await session.appendReasoningDelta("think");
  await session.appendContentDelta("llo");
  await session.finish();

  assertStreamState(client, true);
  assertStreamState(client, false);
  assertUpdateIncludes(client, "reasoning", "think");
  assertUpdateIncludes(client, "content", "hello");
  assertUpdateIncludes(client, "state", "working");
});

test("Feishu agent run indicator saves final card content", async () => {
  const store = memoryCardStore();
  const client = fakeCardClient();
  const indicator = createTestFeishuIndicator({
    client,
    cardStore: store,
    throttleMs: 10_000,
    getState: () => ({ state: "working" })
  });

  const session = await indicator.begin({ round: 0 });
  assert.ok(session);
  await session.appendContentDelta("he");
  await session.appendReasoningDelta("think");
  await session.appendContentDelta("llo");
  await session.finish();

  assertCardRecord(store, {
    messageId: "om_new",
    cardId: "card_new",
    layoutVersion: CARD_LAYOUT_VERSION,
    updatedAt: fixedNow,
    state: "working",
    reasoning: "think",
    content: "hello",
    tools: ""
  });
});

test("Feishu agent run indicator renders raw LLM tool calls below content", async () => {
  const store = memoryCardStore();
  const client = fakeCardClient();
  const indicator = createTestFeishuIndicator({
    client,
    cardStore: store,
    throttleMs: 10_000,
    getState: () => ({ state: "working" })
  });

  const session = await indicator.begin({ round: 0 });
  assert.ok(session);
  await session.appendToolCall({ name: "Search", arguments: "{\"query\":\"alice\"}" });
  await session.appendToolCall({ name: "Demo", arguments: "{\"short\":\"abc\"}" });
  await session.appendToolCall({ name: "Demo", arguments: "{\"short\":\"abc\"}" });
  await session.finish();

  const tools = "Search {\"query\":\"alice\"}\nDemo {\"short\":\"abc\"}\nDemo {\"short\":\"abc\"}";
  assertUpdateIncludes(client, "tools", tools);
  assertCardRecord(store, {
    messageId: "om_new",
    cardId: "card_new",
    layoutVersion: CARD_LAYOUT_VERSION,
    updatedAt: fixedNow,
    state: "working",
    reasoning: "",
    content: "",
    tools
  });
});

test("Feishu agent run indicator reuses persisted card and preserves empty block positions", async () => {
  const store = memoryCardStore({
    messageId: "om_old",
    cardId: "card_old",
    layoutVersion: CARD_LAYOUT_VERSION,
    nextSequence: 7,
    updatedAt: "2026-06-28T00:00:00.000Z"
  });
  const client = fakeCardClient();
  const indicator = createTestFeishuIndicator({
    client,
    cardStore: store,
    throttleMs: 10_000,
    getState: () => ({ state: "waiting", last: "raw" })
  });

  const session = await indicator.begin({ round: 0 });
  assert.ok(session);
  await session.finish();

  assert.equal(client.calls.some((call) => call.kind === "create"), false);
  assertStreamState(client, true);
  assertStreamState(client, false);
  assertUpdateIncludes(client, "reasoning", "");
  assertUpdateIncludes(client, "content", "");
  assertCardRecord(store, {
    messageId: "om_old",
    cardId: "card_old",
    layoutVersion: CARD_LAYOUT_VERSION,
    updatedAt: fixedNow,
    state: "waiting",
    reasoning: "",
    content: "",
    tools: ""
  });
});

test("Feishu agent run indicator clears previous blocks on streamed content", async () => {
  const store = memoryCardStore({
    messageId: "om_old",
    cardId: "card_old",
    layoutVersion: CARD_LAYOUT_VERSION,
    nextSequence: 7,
    updatedAt: "2026-06-28T00:00:00.000Z",
    state: "idle",
    reasoning: "reasoning",
    content: "content"
  });
  const client = fakeCardClient();
  const indicator = createTestFeishuIndicator({
    client,
    cardStore: store,
    throttleMs: 10_000,
    getState: () => ({ state: "waiting" })
  });

  const session = await indicator.begin({ round: 0 });
  assert.ok(session);
  await session.appendReasoningDelta("c");
  await session.appendContentDelta("co");
  await session.finish();

  assertUpdateIncludes(client, "reasoning", "c");
  assertUpdateIncludes(client, "content", "co");
  assertCardRecord(store, {
    messageId: "om_old",
    cardId: "card_old",
    layoutVersion: CARD_LAYOUT_VERSION,
    updatedAt: fixedNow,
    state: "waiting",
    reasoning: "c",
    content: "co",
    tools: ""
  });
});

test("Feishu agent run indicator streams current content while saving clean final blocks", async () => {
  const store = memoryCardStore({
    messageId: "om_old",
    cardId: "card_old",
    layoutVersion: CARD_LAYOUT_VERSION,
    nextSequence: 7,
    updatedAt: "2026-06-28T00:00:00.000Z",
    state: "idle",
    reasoning: "reasoning",
    content: "content"
  });
  const client = fakeCardClient();
  const indicator = createTestFeishuIndicator({
    client,
    cardStore: store,
    throttleMs: 0,
    getState: () => ({ state: "waiting" })
  });

  const session = await indicator.begin({ round: 0 });
  assert.ok(session);
  await session.appendReasoningDelta("c");
  await session.appendContentDelta("c");
  await waitFor(() => client.calls.some((call) => call.kind === "update" && call.block === "reasoning" && call.content === "c")
    && client.calls.some((call) => call.kind === "update" && call.block === "content" && call.content === "c"));
  assertCardRecord(store, {
    messageId: "om_old",
    cardId: "card_old",
    layoutVersion: CARD_LAYOUT_VERSION,
    updatedAt: fixedNow,
    state: "正在输入中...",
    reasoning: "reasoning",
    content: "content",
    tools: ""
  });
  await session.appendReasoningDelta("o");
  await session.appendContentDelta("o");
  await session.finish();

  assertUpdateIncludes(client, "reasoning", "c");
  assertUpdateIncludes(client, "content", "c");
  assertUpdateIncludes(client, "reasoning", "co");
  assertUpdateIncludes(client, "content", "co");
  assertCardRecord(store, {
    messageId: "om_old",
    cardId: "card_old",
    layoutVersion: CARD_LAYOUT_VERSION,
    updatedAt: fixedNow,
    state: "waiting",
    reasoning: "co",
    content: "co",
    tools: ""
  });
});

test("Feishu agent run indicator follows project typing state", async () => {
  const store = memoryCardStore({
    messageId: "om_old",
    cardId: "card_old",
    layoutVersion: CARD_LAYOUT_VERSION,
    nextSequence: 7,
    updatedAt: "2026-06-28T00:00:00.000Z",
    state: "idle",
    reasoning: "think",
    content: "hello"
  });
  const client = fakeCardClient();
  const indicator = createTestFeishuIndicator({
    client,
    cardStore: store,
    getState: () => ({ state: "waiting" })
  });

  await indicator.setTyping?.({ typing: true });
  await indicator.setTyping?.({ typing: false });

  assertUpdateIncludes(client, "state", "正在输入中...");
  assertUpdateIncludes(client, "state", "waiting");
  assertCardRecord(store, {
    messageId: "om_old",
    cardId: "card_old",
    layoutVersion: CARD_LAYOUT_VERSION,
    updatedAt: fixedNow,
    state: "waiting",
    reasoning: "think",
    content: "hello",
    tools: ""
  });
});

test("Feishu agent run indicator creates a card on project typing start", async () => {
  const store = memoryCardStore();
  const client = fakeCardClient();
  const indicator = createTestFeishuIndicator({ client, cardStore: store });

  await indicator.setTyping?.({ typing: true });

  assertCreatedCard(client, { state: "正在输入中...", reasoning: "", content: "", tools: "" });
  assertUpdateIncludes(client, "state", "正在输入中...");
  assertCardRecord(store, {
    messageId: "om_new",
    cardId: "card_new",
    layoutVersion: CARD_LAYOUT_VERSION,
    updatedAt: fixedNow,
    state: "正在输入中...",
    reasoning: "",
    content: "",
    tools: ""
  });
});

test("Feishu agent run indicator recreates old layout cards and keeps saved thinking", async () => {
  const store = memoryCardStore({
    messageId: "om_old",
    cardId: "card_old",
    nextSequence: 7,
    updatedAt: "2026-06-28T00:00:00.000Z",
    state: "idle",
    reasoning: "old think",
    content: "old answer"
  });
  const client = fakeCardClient();
  const indicator = createTestFeishuIndicator({ client, cardStore: store });

  await indicator.setTyping?.({ typing: true });

  assertCreatedCard(client, {
    state: "正在输入中...",
    reasoning: "old think",
    content: "old answer",
    tools: ""
  });
  assertCardRecord(store, {
    messageId: "om_new",
    cardId: "card_new",
    layoutVersion: CARD_LAYOUT_VERSION,
    updatedAt: fixedNow,
    state: "正在输入中...",
    reasoning: "old think",
    content: "old answer",
    tools: ""
  });
});

test("Feishu agent run indicator recreates old layout cards during startup ensure", async () => {
  const store = memoryCardStore({
    messageId: "om_old",
    cardId: "card_old",
    nextSequence: 7,
    updatedAt: "2026-06-28T00:00:00.000Z",
    state: "idle",
    reasoning: "old think",
    content: "old answer"
  });
  const client = fakeCardClient();
  const indicator = createTestFeishuIndicator({ client, cardStore: store });

  await indicator.ensureReady?.();

  assertCreatedCard(client, { state: "waiting", reasoning: "old think", content: "old answer", tools: "" });
  assertCardRecord(store, {
    messageId: "om_new",
    cardId: "card_new",
    layoutVersion: CARD_LAYOUT_VERSION,
    updatedAt: fixedNow,
    state: "waiting",
    reasoning: "old think",
    content: "old answer",
    tools: ""
  });
});

test("Feishu agent run indicator creates a fresh card on demand", async () => {
  const store = memoryCardStore({
    messageId: "om_old",
    cardId: "card_old",
    layoutVersion: CARD_LAYOUT_VERSION,
    nextSequence: 7,
    updatedAt: "2026-06-28T00:00:00.000Z",
    state: "idle",
    reasoning: "old think",
    content: "old answer"
  });
  const client = fakeCardClient();
  const indicator = createTestFeishuIndicator({ client, cardStore: store });

  await indicator.createFreshCard?.();

  assertCreatedCard(client, { state: "waiting", reasoning: "old think", content: "old answer", tools: "" });
  assertCardRecord(store, {
    messageId: "om_new",
    cardId: "card_new",
    layoutVersion: CARD_LAYOUT_VERSION,
    updatedAt: fixedNow,
    state: "waiting",
    reasoning: "old think",
    content: "old answer",
    tools: ""
  });
});

test("Feishu agent run indicator is unavailable without a unique paired open_id target", async () => {
  const client = fakeCardClient();
  const indicator = createTestFeishuIndicator({
    client,
    pairingStore: pairedStore({ contacts: [] }),
    cardStore: memoryCardStore()
  });

  assert.equal(await indicator.begin({ round: 0 }), undefined);
  assert.deepEqual(client.calls, []);
});
