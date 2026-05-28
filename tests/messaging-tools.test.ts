import { test } from "node:test";
import assert from "node:assert/strict";
import { createCurrentTimeProvider } from "../core/time/src/index.js";
import { createMessagingTools } from "../plugins/messaging/src/index.js";
import { createAliceStore } from "../packages/storage/src/sqlite-store.js";
import type { AgentOutput } from "../packages/types/src/index.js";

const fs = await import("node:fs");
const path = await import("node:path");

test("messaging tools expose merged check_chat and send_chat tools", () => {
  const store = createAliceStore(path.join(makeTempDir("messaging-tools"), "alice.sqlite"));
  const tools = createMessagingTools({
    store,
    outputRouter: { async send() {} },
    getDefaultTarget: () => ({ plugin: "feishu", sessionId: "session-1" })
  });

  const names = tools.listTools().map((tool) => tool.name);
  assert.ok(names.includes("check_chat"));
  assert.ok(!names.includes("check_feishu"));
  assert.ok(!names.includes("check_wechat"));
  assert.ok(names.includes("send_chat"));
  assert.ok(!names.includes("send_feishu"));
  assert.ok(!names.includes("send_wechat"));
});

test("check_chat defaults to recent outside llm sessions", async () => {
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
  store.upsertInboundMessage({
    plugin: "wechat",
    externalMessageId: "wx_1",
    conversationId: "wechat-session",
    senderId: "wechat-user",
    contentType: "text",
    contentText: "hello from wechat",
    createdAt: new Date(baseTime + 7 * 60 * 1000).toISOString()
  });

  const tools = createMessagingTools({
    store,
    outputRouter: { async send() {} },
    getUserName: () => "小王",
    getDefaultTarget: () => ({ plugin: "feishu", sessionId: "session-1" })
  });

  const recent = await tools.execute({ id: "call_1", toolName: "check_chat", input: {} });
  assert.equal(recent.ok, true);
  assert.match(String(recent.output), /hello today/);
  assert.match(String(recent.output), /hello from old session/);
  assert.match(String(recent.output), /hello from wechat/);
  assert.match(String(recent.output), /小王:hello today/);
  assert.match(String(recent.output), /Alice:hello back/);
  assert.match(String(recent.output), /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]\n小王:hello today\nAlice:hello back/m);
  assert.doesNotMatch(String(recent.output), /\[(?:today|yesterday) /);
  assert.equal((String(recent.output).match(/^\[/gm) ?? []).length, 2);
  assert.doesNotMatch(String(recent.output), /\.\d{3}Z/);
  assert.match(String(recent.output), /^<chat-log>\n/);
  assert.match(String(recent.output), /\n<\/chat-log>\n<time>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}<\\time>$/);
  const readMessages = store.listMessages(10).filter((message) => message.direction === "inbound");
  assert.equal(readMessages.length, 3);
  assert.deepEqual(readMessages.map((message) => Boolean(message.isRead)), [true, true, true]);
  assert.deepEqual(readMessages.map((message) => Boolean(message.readAt)), [true, true, true]);
  assert.deepEqual(readMessages.map((message) => Boolean(message.coreProcessedAt)), [true, true, true]);
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

  const recentAgain = await tools.execute({ id: "call_2", toolName: "check_chat", input: {} });
  assert.equal(recentAgain.ok, true);
  assert.match(String(recentAgain.output), /hello today/);
  assert.match(String(recentAgain.output), /after today check/);
});

test("check_chat defaults to new after first recent call in the same llm session", async () => {
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
  const first = await tools.execute({ id: "call_1", toolName: "check_chat", input: {} });
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
  store.upsertInboundMessage({
    plugin: "wechat",
    externalMessageId: "wx_1",
    conversationId: "wechat-session",
    senderId: "wechat-user",
    contentType: "text",
    contentText: "wechat after first check",
    createdAt: "2026-05-26T12:02:00.000Z"
  });

  tools.noteLLMRequestStarted();
  const second = await tools.execute({ id: "call_2", toolName: "check_chat", input: {} });
  assert.equal(second.ok, true);
  assert.doesNotMatch(String(second.output), /initial today/);
  assert.match(String(second.output), /after first default check/);
  assert.match(String(second.output), /wechat after first check/);

  const third = await tools.execute({ id: "call_3", toolName: "check_chat", input: {} });
  assert.equal(third.ok, true);
  assert.match(String(third.output), /^<chat-log>\nnothing new\n<\/chat-log>\n<time>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}<\\time>$/);

  tools.noteLLMSessionCompleted();
  tools.noteLLMRequestStarted();
  const nextSessionFirst = await tools.execute({ id: "call_4", toolName: "check_chat", input: {} });
  assert.equal(nextSessionFirst.ok, true);
  assert.match(String(nextSessionFirst.output), /initial today/);
});

test("check_chat renders system prompts as system messages", async () => {
  const store = createAliceStore(path.join(makeTempDir("messaging-system-prompts"), "alice.sqlite"));
  store.insertOutboundMessage({
    plugin: "feishu",
    conversationId: "session-1",
    senderRole: "system",
    contentType: "text",
    contentText: "-少女拍照中-",
    createdAt: "2026-05-26T12:00:00.000Z"
  });
  store.insertOutboundMessage({
    plugin: "feishu",
    conversationId: "session-1",
    contentType: "text",
    contentText: "(大失败...)",
    createdAt: "2026-05-26T12:00:01.000Z"
  });

  const tools = createMessagingTools({
    store,
    time: createCurrentTimeProvider("Asia/Shanghai", () => new Date("2026-05-26T12:01:00.000Z")),
    outputRouter: { async send() {} },
    getDefaultTarget: () => ({ plugin: "feishu", sessionId: "session-1" })
  });

  const result = await tools.execute({ id: "call_system_prompt", toolName: "check_chat", input: {} });
  assert.equal(result.ok, true);
  assert.match(String(result.output), /\n-少女拍照中-\n/);
  assert.doesNotMatch(String(result.output), /-少女拍照中-\[发送中\]/);
  assert.doesNotMatch(String(result.output), /\(大失败\.\.\.\)\[发送中\]/);
  assert.match(String(result.output), /\n\(大失败\.\.\.\)/);
  assert.doesNotMatch(String(result.output), /system:/);
  assert.doesNotMatch(String(result.output), /Alice:-少女拍照中-/);
  assert.doesNotMatch(String(result.output), /Alice:\(大失败\.\.\.\)/);
});

test("check_chat simplifies outbound media records", async () => {
  const store = createAliceStore(path.join(makeTempDir("messaging-media-records"), "alice.sqlite"));
  store.insertOutboundMessage({
    plugin: "feishu",
    conversationId: "session-1",
    contentType: "image",
    contentText: "generated/selfies/selfie_20260528_160956.jpg",
    contentJson: JSON.stringify({ kind: "image", assetId: "generated/selfies/selfie_20260528_160956.jpg" }),
    createdAt: "2026-05-26T12:00:00.000Z"
  });
  store.insertOutboundMessage({
    plugin: "feishu",
    conversationId: "session-1",
    contentType: "audio",
    contentText: "voice-1.mp3",
    contentJson: JSON.stringify({ kind: "audio", assetId: "voice-1.mp3", transcript: "晚点见" }),
    createdAt: "2026-05-26T12:00:01.000Z"
  });
  store.insertOutboundMessage({
    plugin: "feishu",
    conversationId: "session-1",
    contentType: "file",
    contentText: "report.pdf",
    contentJson: JSON.stringify({ kind: "file", assetId: "files/report.pdf", filename: "report.pdf" }),
    createdAt: "2026-05-26T12:00:02.000Z"
  });

  const tools = createMessagingTools({
    store,
    time: createCurrentTimeProvider("Asia/Shanghai", () => new Date("2026-05-26T12:01:00.000Z")),
    outputRouter: { async send() {} },
    getDefaultTarget: () => ({ plugin: "feishu", sessionId: "session-1" })
  });

  const result = await tools.execute({ id: "call_media_records", toolName: "check_chat", input: {} });
  assert.equal(result.ok, true);
  assert.match(String(result.output), /Alice发送了一张图片/);
  assert.doesNotMatch(String(result.output), /Alice:发送了一张图片/);
  assert.match(String(result.output), /Alice:\[语音\]晚点见/);
  assert.match(String(result.output), /Alice发送了文件\[report\.pdf\]/);
  assert.doesNotMatch(String(result.output), /Alice:发送了文件\[report\.pdf\]/);
  assert.doesNotMatch(String(result.output), /selfie_20260528_160956\.jpg/);
});

test("check_chat recent returns only the latest 50 messages from the 500 message window", async () => {
  const store = createAliceStore(path.join(makeTempDir("messaging-recent-limit"), "alice.sqlite"));
  for (let index = 1; index <= 560; index += 1) {
    store.upsertInboundMessage({
      plugin: "feishu",
      externalMessageId: `om_${index}`,
      conversationId: index % 2 === 0 ? "session-1" : "legacy-session",
      senderId: "user-1",
      contentType: "text",
      contentText: `msg ${index}`,
      createdAt: new Date(Date.UTC(2026, 4, 26, 0, 0, index)).toISOString()
    });
  }
  const tools = createMessagingTools({
    store,
    outputRouter: { async send() {} },
    getDefaultTarget: () => ({ plugin: "feishu", sessionId: "session-1" })
  });

  const recent = await tools.execute({ id: "call_recent", toolName: "check_chat", input: {} });
  assert.equal(recent.ok, true);
  assert.doesNotMatch(String(recent.output), /msg 60\b/);
  assert.doesNotMatch(String(recent.output), /msg 510\b/);
  assert.match(String(recent.output), /msg 511\b/);
  assert.match(String(recent.output), /msg 560\b/);
  assert.equal((String(recent.output).match(/user:msg /g) ?? []).length, 50);
});

test("check_chat preview does not mark messages read or advance cursor", async () => {
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
    toolName: "check_chat",
    input: { __preview: true }
  });
  assert.equal(preview.ok, true);
  assert.match(String(preview.output), /preview should not consume/);

  const stored = store.listMessagesForConversation("session-1", 10)[0];
  assert.equal(Boolean(stored.isRead), false);
  assert.equal(stored.readAt ?? undefined, undefined);
  assert.equal(stored.coreProcessedAt ?? undefined, undefined);
  assert.equal(store.listPendingCoreConversations()[0].conversationId, "session-1");
});

test("check_chat recent is independent of the 6am today anchor", async () => {
  const store = createAliceStore(path.join(makeTempDir("messaging-recent-anchor"), "alice.sqlite"));
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
  const beforeResult = await beforeSix.execute({ id: "call_before", toolName: "check_chat", input: {} });
  assert.match(String(beforeResult.output), /prev evening/);
  assert.match(String(beforeResult.output), /today early/);

  const afterSix = createMessagingTools({
    store,
    time: createCurrentTimeProvider("Asia/Shanghai", () => new Date("2026-05-25T22:30:00.000Z")),
    outputRouter: { async send() {} },
    getDefaultTarget: () => ({ plugin: "feishu", sessionId: "session-1" })
  });
  const afterResult = await afterSix.execute({ id: "call_after", toolName: "check_chat", input: {} });
  assert.match(String(afterResult.output), /prev evening/);
  assert.match(String(afterResult.output), /today early/);
});

test("check_chat chat labels use absolute local time", async () => {
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

  const result = await tools.execute({ id: "call_time_label", toolName: "check_chat", input: {} });
  assert.match(String(result.output), /\[2026-05-25 23:30:00\]\nuser:late yesterday/);
  assert.doesNotMatch(String(result.output), /\[(?:today|yesterday) /);
});

test("check_chat merges shell switch logs into chat context", async () => {
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
      time: "2026-05-26T10:02:00.000Z",
      personalityName: "冷淡",
      relationshipName: "同桌"
    }]
  });

  const result = await tools.execute({ id: "call_shell_switch", toolName: "check_chat", input: {} });
  assert.equal(result.ok, true);
  assert.match(String(result.output), /user:hello\n-壳切换:切换为冷淡的同桌爱丽丝-/);
  assert.doesNotMatch(String(result.output), /system:/);
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

test("send_chat defaults to message and splits newline text into multiple sends", async () => {
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
  await tools.execute({ id: "call_check_today", toolName: "check_chat", input: {} });
  const result = await tools.execute({
    id: "call_send",
    toolName: "send_chat",
    input: { content: "one\n\ntwo" }
  });

  assert.equal(result.ok, true);
  assert.match(String(result.output), /^<chat-log>\n/);
  assert.match(String(result.output), /Alice:one/);
  assert.match(String(result.output), /Alice:two/);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map((output) => output.content.kind === "text" ? output.content.text : ""), ["one", "two"]);
  const stored = store.listMessagesForConversation("session-1", 10).filter((message) => message.direction === "outbound");
  assert.equal(stored.length, 2);
  assert.deepEqual(stored.map((message) => message.externalMessageId), ["sent_1", "sent_2"]);

  const noNew = await tools.execute({ id: "call_check_new", toolName: "check_chat", input: {} });
  assert.equal(noNew.ok, true);
  assert.match(String(noNew.output), /^<chat-log>\nnothing new\n<\/chat-log>\n<time>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}<\\time>$/);
});

test("send_chat normalizes prefixed feishu chat ids before sending", async () => {
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
    toolName: "send_chat",
    input: { content: "test" }
  });

  assert.equal(result.ok, true);
  assert.equal(sent[0].target.channelId, "oc_018825f465c5e6a00e32739f76f47271");
  assert.equal(sent[0].target.sessionId, "feishu:dm:oc_018825f465c5e6a00e32739f76f47271");
});

test("send_chat returns failed outbound messages as chat records", async () => {
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
    toolName: "send_chat",
    input: { content: "test" }
  });

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(result.ok, false);
  assert.match(String(result.output), /^<chat-log>\n/);
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
