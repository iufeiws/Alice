import { test } from "node:test";
import assert from "node:assert/strict";
import { createCurrentTimeProvider } from "../core/time/src/index.js";
import { createMessagingTools } from "../plugins/messaging/src/index.js";
import { createAliceStore } from "../packages/storage/src/sqlite-store.js";
import type { AgentOutput } from "../packages/types/src/index.js";

const fs = await import("node:fs");
const path = await import("node:path");

test("check_feishu defaults to today and new scope advances a cursor", async () => {
  const store = createAliceStore(path.join(makeTempDir("messaging-view"), "alice.sqlite"));
  const baseTime = Date.now();
  store.upsertInboundMessage({
    plugin: "feishu",
    externalMessageId: "om_1",
    conversationId: "session-1",
    senderId: "user-1",
    contentType: "text",
    contentText: "hello today",
    createdAt: new Date(baseTime).toISOString()
  });
  store.insertOutboundMessage({
    plugin: "feishu",
    conversationId: "session-1",
    contentType: "text",
    contentText: "hello back",
    createdAt: new Date(baseTime + 1000).toISOString()
  });
  store.upsertInboundMessage({
    plugin: "feishu",
    externalMessageId: "om_2",
    conversationId: "legacy-session",
    senderId: "user-1",
    contentType: "text",
    contentText: "hello from old session",
    createdAt: new Date(baseTime + 6 * 60 * 1000).toISOString()
  });

  const tools = createMessagingTools({
    store,
    outputRouter: { async send() {} },
    getUserName: () => "小王",
    getDefaultTarget: () => ({ plugin: "feishu", sessionId: "session-1" })
  });

  const today = await tools.execute({ id: "call_1", toolName: "check_feishu", input: {} });
  assert.equal(today.ok, true);
  assert.match(String(today.output), /hello today/);
  assert.match(String(today.output), /hello from old session/);
  assert.match(String(today.output), /小王:hello today/);
  assert.match(String(today.output), /Alice:hello back/);
  assert.match(String(today.output), /^\[(?:\d{2}:\d{2}|\d{2}-\d{2} \d{2}:\d{2}|\d{4}-\d{2}-\d{2} \d{2}:\d{2})\]\n小王:hello today\nAlice:hello back/m);
  assert.doesNotMatch(String(today.output), /^\[.*:\d{2}:\d{2}\]/m);
  assert.equal((String(today.output).match(/^\[/gm) ?? []).length, 2);
  assert.doesNotMatch(String(today.output), /\.\d{3}Z/);
  assert.match(String(today.output), /^<chat>\n/);
  assert.match(String(today.output), /\n<\/chat>\nCurrent time is \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]$/);

  const firstNew = await tools.execute({ id: "call_2", toolName: "check_feishu", input: { scope: "new" } });
  assert.equal(firstNew.ok, true);
  assert.match(String(firstNew.output), /hello today/);

  const secondNew = await tools.execute({ id: "call_3", toolName: "check_feishu", input: { scope: "new" } });
  assert.equal(secondNew.ok, true);
  assert.match(String(secondNew.output), /^<chat>\nnothing new\n<\/chat>\nCurrent time is \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]$/);
});

test("check_feishu today starts at previous midnight before 6am and current midnight after 6am", async () => {
  const store = createAliceStore(path.join(makeTempDir("messaging-today-anchor"), "alice.sqlite"));
  for (const [externalMessageId, contentText, createdAt] of [
    ["om_prev_evening", "prev evening", "2026-05-25T23:00:00.000"],
    ["om_today_early", "today early", "2026-05-26T01:00:00.000"]
  ] as const) {
    store.upsertInboundMessage({
      plugin: "feishu",
      externalMessageId,
      conversationId: "session-1",
      senderId: "user-1",
      contentType: "text",
      contentText,
      createdAt
    });
  }

  const beforeSix = createMessagingTools({
    store,
    time: createCurrentTimeProvider("Asia/Shanghai", () => new Date("2026-05-25T21:30:00.000Z")),
    outputRouter: { async send() {} },
    getDefaultTarget: () => ({ plugin: "feishu", sessionId: "session-1" })
  });
  const beforeResult = await beforeSix.execute({ id: "call_before", toolName: "check_feishu", input: {} });
  assert.match(String(beforeResult.output), /prev evening/);
  assert.match(String(beforeResult.output), /today early/);

  const afterSix = createMessagingTools({
    store,
    time: createCurrentTimeProvider("Asia/Shanghai", () => new Date("2026-05-25T22:30:00.000Z")),
    outputRouter: { async send() {} },
    getDefaultTarget: () => ({ plugin: "feishu", sessionId: "session-1" })
  });
  const afterResult = await afterSix.execute({ id: "call_after", toolName: "check_feishu", input: {} });
  assert.doesNotMatch(String(afterResult.output), /prev evening/);
  assert.match(String(afterResult.output), /today early/);
});

test("check_feishu chat labels use the injected current time", async () => {
  const store = createAliceStore(path.join(makeTempDir("messaging-injected-now"), "alice.sqlite"));
  store.upsertInboundMessage({
    plugin: "feishu",
    externalMessageId: "om_yesterday",
    conversationId: "session-1",
    senderId: "user-1",
    contentType: "text",
    contentText: "late yesterday",
    createdAt: "2026-05-25T15:30:00.000Z"
  });

  const tools = createMessagingTools({
    store,
    time: createCurrentTimeProvider("Asia/Shanghai", () => new Date("2026-05-25T21:00:00.000Z")),
    outputRouter: { async send() {} },
    getDefaultTarget: () => ({ plugin: "feishu", sessionId: "session-1" })
  });

  const result = await tools.execute({ id: "call_time_label", toolName: "check_feishu", input: {} });
  assert.match(String(result.output), /\[yesterday 23:30\]\nuser:late yesterday/);
});

test("search_messages uses persisted message FTS with default limits and context", async () => {
  const store = createAliceStore(path.join(makeTempDir("messaging-search"), "alice.sqlite"));
  for (const [index, text] of ["before", "project alpha decision", "after"].entries()) {
    store.upsertInboundMessage({
      plugin: "feishu",
      externalMessageId: `om_${index}`,
      conversationId: "session-1",
      senderId: "user-1",
      contentType: "text",
      contentText: text,
      createdAt: new Date(Date.now() + index).toISOString()
    });
  }

  const tools = createMessagingTools({
    store,
    outputRouter: { async send() {} },
    getDefaultTarget: () => ({ plugin: "feishu", sessionId: "session-1" })
  });
  const result = await tools.execute({
    id: "call_search",
    toolName: "search_messages",
    input: { content: "project alpha" }
  });

  assert.equal(result.ok, true);
  assert.match(String(result.output), /project alpha decision/);
});

test("send_feishu defaults to message and splits newline text into multiple sends", async () => {
  const store = createAliceStore(path.join(makeTempDir("messaging-send"), "alice.sqlite"));
  const sent: AgentOutput[] = [];
  const tools = createMessagingTools({
    store,
    time: createCurrentTimeProvider("UTC", () => new Date("2026-05-26T00:00:00.000Z")),
    outputRouter: {
      async send(output) {
        sent.push(output);
        return { messageId: `sent_${sent.length}` };
      }
    },
    getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" })
  });

  const result = await tools.execute({
    id: "call_send",
    toolName: "send_feishu",
    input: { content: "one\n\ntwo" }
  });

  assert.equal(result.ok, true);
  assert.match(String(result.output), /#1 message sent sent_1: one/);
  assert.match(String(result.output), /#2 message sent sent_2: two/);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map((output) => output.content.kind === "text" ? output.content.text : ""), ["one", "two"]);
  const stored = store.listMessagesForConversation("session-1", 10).filter((message) => message.direction === "outbound");
  assert.equal(stored.length, 2);
  assert.deepEqual(stored.map((message) => message.externalMessageId), ["sent_1", "sent_2"]);
});

function makeTempDir(name: string): string {
  const dir = path.join("/tmp", `alice-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
