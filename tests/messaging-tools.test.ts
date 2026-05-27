import { test } from "node:test";
import assert from "node:assert/strict";
import { createCurrentTimeProvider } from "../core/time/src/index.js";
import { createMessagingTools } from "../plugins/messaging/src/index.js";
import { createAliceStore } from "../packages/storage/src/sqlite-store.js";
import type { AgentOutput } from "../packages/types/src/index.js";

const fs = await import("node:fs");
const path = await import("node:path");

test("check_feishu defaults to today outside llm sessions", async () => {
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
  const readMessages = store.listMessages(10).filter((message) => message.direction === "inbound");
  assert.equal(readMessages.length, 2);
  assert.deepEqual(readMessages.map((message) => Boolean(message.isRead)), [true, true]);
  assert.deepEqual(readMessages.map((message) => Boolean(message.readAt)), [true, true]);
  assert.deepEqual(readMessages.map((message) => Boolean(message.coreProcessedAt)), [true, true]);
  assert.deepEqual(store.listPendingCoreConversations(), []);

  store.upsertInboundMessage({
    plugin: "feishu",
    externalMessageId: "om_3",
    conversationId: "session-1",
    senderId: "user-1",
    contentType: "text",
    contentText: "after today check",
    createdAt: new Date(baseTime + 7 * 60 * 1000).toISOString()
  });

  const todayAgain = await tools.execute({ id: "call_2", toolName: "check_feishu", input: {} });
  assert.equal(todayAgain.ok, true);
  assert.match(String(todayAgain.output), /hello today/);
  assert.match(String(todayAgain.output), /after today check/);
});

test("check_feishu defaults to new after first call in the same llm session", async () => {
  const store = createAliceStore(path.join(makeTempDir("messaging-view-llm-session"), "alice.sqlite"));
  store.upsertInboundMessage({
    plugin: "feishu",
    externalMessageId: "om_1",
    conversationId: "session-1",
    senderId: "user-1",
    contentType: "text",
    contentText: "initial today",
    createdAt: "2026-05-26T01:00:00.000Z"
  });

  const tools = createMessagingTools({
    store,
    time: createCurrentTimeProvider("Asia/Shanghai", () => new Date("2026-05-26T12:00:00.000Z")),
    outputRouter: { async send() {} },
    getDefaultTarget: () => ({ plugin: "feishu", sessionId: "session-1" })
  });

  tools.noteLLMRequestStarted();
  const first = await tools.execute({ id: "call_1", toolName: "check_feishu", input: {} });
  assert.equal(first.ok, true);
  assert.match(String(first.output), /initial today/);

  store.upsertInboundMessage({
    plugin: "feishu",
    externalMessageId: "om_2",
    conversationId: "session-1",
    senderId: "user-1",
    contentType: "text",
    contentText: "after first default check",
    createdAt: "2026-05-26T12:01:00.000Z"
  });

  tools.noteLLMRequestStarted();
  const second = await tools.execute({ id: "call_2", toolName: "check_feishu", input: {} });
  assert.equal(second.ok, true);
  assert.doesNotMatch(String(second.output), /initial today/);
  assert.match(String(second.output), /after first default check/);

  const third = await tools.execute({ id: "call_3", toolName: "check_feishu", input: {} });
  assert.equal(third.ok, true);
  assert.match(String(third.output), /^<chat>\nnothing new\n<\/chat>\nCurrent time is \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]$/);

  tools.noteLLMSessionCompleted();
  tools.noteLLMRequestStarted();
  const nextSessionFirst = await tools.execute({ id: "call_4", toolName: "check_feishu", input: {} });
  assert.equal(nextSessionFirst.ok, true);
  assert.match(String(nextSessionFirst.output), /initial today/);
});

test("check_feishu preview does not mark messages read or advance cursor", async () => {
  const store = createAliceStore(path.join(makeTempDir("messaging-view-preview"), "alice.sqlite"));
  store.upsertInboundMessage({
    plugin: "feishu",
    externalMessageId: "om_1",
    conversationId: "session-1",
    senderId: "user-1",
    contentType: "text",
    contentText: "preview should not consume",
    createdAt: "2026-05-26T12:01:00.000"
  });

  const tools = createMessagingTools({
    store,
    time: createCurrentTimeProvider("Asia/Shanghai", () => new Date("2026-05-26T12:02:00.000Z")),
    outputRouter: { async send() {} },
    getDefaultTarget: () => ({ plugin: "feishu", sessionId: "session-1" })
  });

  const preview = await tools.execute({
    id: "call_preview",
    toolName: "check_feishu",
    input: { __preview: true }
  });
  assert.equal(preview.ok, true);
  assert.match(String(preview.output), /preview should not consume/);

  const stored = store.listMessagesForConversation("session-1", 10)[0];
  assert.equal(Boolean(stored.isRead), false);
  assert.equal(stored.readAt ?? undefined, undefined);
  assert.equal(stored.coreProcessedAt ?? undefined, undefined);
  assert.equal(store.getToolCursor("feishu", "session-1", "check_feishu"), undefined);
  assert.equal(store.listPendingCoreConversations()[0].conversationId, "session-1");
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

test("check_feishu merges shell switch logs into chat context", async () => {
  const store = createAliceStore(path.join(makeTempDir("messaging-shell-switch"), "alice.sqlite"));
  store.upsertInboundMessage({
    plugin: "feishu",
    externalMessageId: "om_1",
    conversationId: "session-1",
    senderId: "user-1",
    contentType: "text",
    contentText: "hello",
    createdAt: "2026-05-26T10:01:00.000Z"
  });

  const tools = createMessagingTools({
    store,
    time: createCurrentTimeProvider("Asia/Shanghai", () => new Date("2026-05-26T12:00:00.000Z")),
    outputRouter: { async send() {} },
    getDefaultTarget: () => ({ plugin: "feishu", sessionId: "session-1" }),
    getShellSwitchLogs: () => [{
      time: "2026-05-26T10:00:00.000Z",
      personalityName: "冷淡",
      relationshipName: "同桌"
    }]
  });

  const result = await tools.execute({ id: "call_shell_switch", toolName: "check_feishu", input: {} });
  assert.equal(result.ok, true);
  assert.match(String(result.output), /\(壳切换-切换为冷淡的同桌爱丽丝\)\nuser:hello/);
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
    sleep: async () => {},
    outputRouter: {
      async send(output) {
        sent.push(output);
        return { messageId: `sent_${sent.length}` };
      }
    },
    getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" })
  });

  tools.noteLLMRequestStarted();
  await tools.execute({ id: "call_check_today", toolName: "check_feishu", input: {} });
  const result = await tools.execute({
    id: "call_send",
    toolName: "send_feishu",
    input: { content: "one\n\ntwo" }
  });

  assert.equal(result.ok, true);
  assert.match(String(result.output), /^<chat>\n/);
  assert.match(String(result.output), /Alice:one/);
  assert.match(String(result.output), /Alice:two/);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map((output) => output.content.kind === "text" ? output.content.text : ""), ["one", "two"]);
  const stored = store.listMessagesForConversation("session-1", 10).filter((message) => message.direction === "outbound");
  assert.equal(stored.length, 2);
  assert.deepEqual(stored.map((message) => message.externalMessageId), ["sent_1", "sent_2"]);

  const noNew = await tools.execute({ id: "call_check_new", toolName: "check_feishu", input: {} });
  assert.equal(noNew.ok, true);
  assert.match(String(noNew.output), /^<chat>\nnothing new\n<\/chat>\nCurrent time is \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]$/);
});

test("send_feishu normalizes prefixed feishu chat ids before sending", async () => {
  const store = createAliceStore(path.join(makeTempDir("messaging-send-feishu-id"), "alice.sqlite"));
  const sent: AgentOutput[] = [];
  const tools = createMessagingTools({
    store,
    time: createCurrentTimeProvider("UTC", () => new Date("2026-05-26T00:00:00.000Z")),
    sleep: async () => {},
    outputRouter: {
      async send(output) {
        sent.push(output);
        return { messageId: "sent_1" };
      }
    },
    getDefaultTarget: () => ({
      plugin: "feishu",
      channelId: "feishu:dm:oc_018825f465c5e6a00e32739f76f47271",
      sessionId: "feishu:dm:oc_018825f465c5e6a00e32739f76f47271"
    })
  });

  const result = await tools.execute({
    id: "call_send",
    toolName: "send_feishu",
    input: { content: "test" }
  });

  assert.equal(result.ok, true);
  assert.equal(sent[0].target.channelId, "oc_018825f465c5e6a00e32739f76f47271");
  assert.equal(sent[0].target.sessionId, "feishu:dm:oc_018825f465c5e6a00e32739f76f47271");
});

test("send_feishu returns failed outbound messages as chat records", async () => {
  const store = createAliceStore(path.join(makeTempDir("messaging-send-failed"), "alice.sqlite"));
  const logs: Array<{ status?: string; error?: string; summary: string }> = [];
  const tools = createMessagingTools({
    store,
    time: createCurrentTimeProvider("UTC", () => new Date("2026-05-26T00:00:00.000Z")),
    sleep: async () => {},
    outputRouter: {
      async send() {
        throw {
          message: "Request failed with status code 400",
          response: {
            status: 400,
            data: {
              code: 230001,
              msg: "invalid receive_id",
              error: { log_id: "log_1" }
            }
          }
        };
      }
    },
    getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" }),
    appendMessageLog(input) {
      logs.push({ status: input.status, error: input.error, summary: input.summary });
    }
  });

  const result = await tools.execute({
    id: "call_send",
    toolName: "send_feishu",
    input: { content: "test" }
  });

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(result.ok, false);
  assert.match(String(result.output), /^<chat>\n/);
  assert.match(String(result.output), /Alice:test\[发送失败\]/);
  assert.doesNotMatch(String(result.output), /#1 message failed/);
  assert.equal(logs[0].status, "send_failed");
  assert.equal(logs[0].error, "Feishu API 230001: invalid receive_id log_id=log_1");
  assert.equal(logs.filter((entry) => entry.status === "retry_failed").length, 1);
});

test("send_message waits from llm start using content length based delay", async () => {
  const store = createAliceStore(path.join(makeTempDir("messaging-send-delay"), "alice.sqlite"));
  let nowMs = Date.parse("2026-05-26T00:00:00.000Z");
  const sleeps: number[] = [];
  const sentAt: number[] = [];
  const tools = createMessagingTools({
    store,
    time: createCurrentTimeProvider("UTC", () => new Date(nowMs)),
    sleep: async (ms) => {
      sleeps.push(ms);
      nowMs += ms;
    },
    outputRouter: {
      async send() {
        sentAt.push(nowMs);
        return { messageId: `sent_${sentAt.length}` };
      }
    },
    getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" })
  });

  tools.noteLLMRequestStarted();
  const result = await tools.execute({
    id: "call_send_delay",
    toolName: "send_message",
    input: { content: "hello\nworldwide" }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(sleeps, [2400, 4320]);
  assert.deepEqual(sentAt, [
    Date.parse("2026-05-26T00:00:02.400Z"),
    Date.parse("2026-05-26T00:00:06.720Z")
  ]);
});

test("send_message updates delay timestamp before send attempt completes", async () => {
  const store = createAliceStore(path.join(makeTempDir("messaging-send-attempt-delay"), "alice.sqlite"));
  let nowMs = Date.parse("2026-05-26T00:00:00.000Z");
  const sleeps: number[] = [];
  const sentAt: number[] = [];
  const tools = createMessagingTools({
    store,
    time: createCurrentTimeProvider("UTC", () => new Date(nowMs)),
    sleep: async (ms) => {
      sleeps.push(ms);
      nowMs += ms;
    },
    outputRouter: {
      async send() {
        sentAt.push(nowMs);
        nowMs += 100;
        return { messageId: `sent_${sentAt.length}` };
      }
    },
    getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" })
  });

  const result = await tools.execute({
    id: "call_send_attempt_delay",
    toolName: "send_message",
    input: { content: "hello\nhello" }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(sleeps, [2300]);
  assert.deepEqual(sentAt, [
    Date.parse("2026-05-26T00:00:00.000Z"),
    Date.parse("2026-05-26T00:00:02.400Z")
  ]);
});

test("send_message failed attempt occupies delay window and retries queued send", async () => {
  const store = createAliceStore(path.join(makeTempDir("messaging-send-retry"), "alice.sqlite"));
  let nowMs = Date.parse("2026-05-26T00:00:00.000Z");
  const sleeps: number[] = [];
  const attemptsAt: number[] = [];
  const logs: string[] = [];
  const tools = createMessagingTools({
    store,
    time: createCurrentTimeProvider("UTC", () => new Date(nowMs)),
    sleep: async (ms) => {
      sleeps.push(ms);
      nowMs += ms;
    },
    outputRouter: {
      async send() {
        attemptsAt.push(nowMs);
        if (attemptsAt.length === 1) throw new Error("temporary send failure");
        return { messageId: `sent_${attemptsAt.length}` };
      }
    },
    getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" }),
    appendMessageLog(input) {
      if (input.status) logs.push(input.status);
    }
  });

  const result = await tools.execute({
    id: "call_send_retry",
    toolName: "send_message",
    input: { content: "hello" }
  });
  await eventually(() => attemptsAt.length >= 2);

  assert.equal(result.ok, false);
  assert.equal(result.error, "temporary send failure");
  assert.deepEqual(sleeps, [2400]);
  assert.deepEqual(attemptsAt, [
    Date.parse("2026-05-26T00:00:00.000Z"),
    Date.parse("2026-05-26T00:00:02.400Z")
  ]);
  assert.deepEqual(logs, ["send_failed", "retry_sent"]);
  const stored = store.listMessagesForConversation("session-1", 10).filter((message) => message.direction === "outbound");
  assert.equal(stored.length, 1);
  assert.equal(stored[0].status, "sent");
  assert.equal(stored[0].externalMessageId, "sent_2");
});

test("send_message sends immediately when llm work already exceeded the content delay", async () => {
  const store = createAliceStore(path.join(makeTempDir("messaging-send-delay-elapsed"), "alice.sqlite"));
  let nowMs = Date.parse("2026-05-26T00:00:00.000Z");
  const sleeps: number[] = [];
  const tools = createMessagingTools({
    store,
    time: createCurrentTimeProvider("UTC", () => new Date(nowMs)),
    sleep: async (ms) => {
      sleeps.push(ms);
      nowMs += ms;
    },
    outputRouter: {
      async send() {
        return { messageId: "sent_1" };
      }
    },
    getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" })
  });

  tools.noteLLMRequestStarted();
  nowMs += 1_000;
  const result = await tools.execute({
    id: "call_send_elapsed",
    toolName: "send_message",
    input: { content: "hi" }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(sleeps, []);
});

async function eventually(condition: () => boolean, timeoutMs = 500): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("condition was not met before timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function makeTempDir(name: string): string {
  const dir = path.join("/tmp", `alice-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
