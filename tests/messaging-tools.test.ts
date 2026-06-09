import { test } from "node:test";
import assert from "node:assert/strict";
import { createCurrentTimeProvider } from "../src/platform/time/src/index.js";
import { formatToolResultForLLM } from "../src/contexts/agent-profile/src/application/llm-text-renderer.js";
import { createMessagingTools } from "../src/capabilities/tools/messaging/src/index.js";
import { collectTtsStreamText, createConfiguredVoiceSynthesizer, createFallbackVoiceSynthesizer, createGenieTtsVoiceSynthesizer, createMossOnnxVoiceSynthesizer, createOpenAiApiTtsVoiceSynthesizer, createTtsPcmProgressTextMapper, createTtsPlugin, createTtsTranslationSynthesizer, ttsGenieOverrides, readTtsPluginConfig } from "../src/channels/tts/src/index.js";
import { createAliceStore } from "../src/contexts/conversation-hub/src/adapters/sqlite-conversation-store.js";
import type { AgentOutput } from "../src/contexts/agent-loop/src/contracts/agent-contracts.js";

const fs = await import("node:fs");
const fsp = await import("node:fs/promises");
const path = await import("node:path");
const events = await import("node:events");

const genieRequiredModelFiles = [
  "t2s_encoder_fp32.bin",
  "t2s_encoder_fp32.onnx",
  "t2s_first_stage_decoder_fp32.onnx",
  "t2s_shared_fp16.bin",
  "t2s_stage_decoder_fp32.onnx",
  "vits_fp16.bin",
  "vits_fp32.onnx"
];

test("messaging tools expose merged check_chat, send_chat, and wait_chat tools", async () => {
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
  assert.ok(names.includes("wait_chat"));
  assert.ok(!names.includes("search_messages"));
  const checkChat = tools.listTools().find((tool) => tool.name === "check_chat");
  const properties = checkChat?.inputSchema.properties as Record<string, unknown>;
  assert.deepEqual(properties, {});
  assert.equal(checkChat?.inputSchema.additionalProperties, false);
  const waitChat = tools.listTools().find((tool) => tool.name === "wait_chat");
  assert.equal(waitChat?.description, "等待聊天记录更新。当有新消息时会收到提醒并返回新消息。");
  assert.deepEqual(waitChat?.inputSchema.properties, {});
  assert.equal(waitChat?.inputSchema.additionalProperties, false);
  const result = await tools.execute({ id: "call_wait", toolName: "wait_chat", input: {} });
  assert.equal(result.ok, true);
  assert.equal(result.meta?.yieldReturn, true);
  assert.equal(result.output, undefined);
});

test("check_chat range scope filters with from and to", async () => {
  const store = createAliceStore(path.join(makeTempDir("messaging-range-scope"), "alice.sqlite"), {
    time: createCurrentTimeProvider("Asia/Shanghai")
  });
  store.upsertInboundMessage({
    plugin: "feishu",
    externalMessageId: "om_1",
    conversationId: "session-1",
    senderId: "user-1",
    contentType: "text",
    contentText: "before range",
    createdAt: "2026-05-24T00:59:00.000Z"
  });
  store.upsertInboundMessage({
    plugin: "feishu",
    externalMessageId: "om_2",
    conversationId: "session-1",
    senderId: "user-1",
    contentType: "text",
    contentText: "inside range",
    createdAt: "2026-05-24T01:00:00.000Z"
  });
  store.upsertInboundMessage({
    plugin: "feishu",
    externalMessageId: "om_3",
    conversationId: "session-1",
    senderId: "user-1",
    contentType: "text",
    contentText: "after range",
    createdAt: "2026-05-24T02:00:00.000Z"
  });
  const tools = createMessagingTools({
    store,
    outputRouter: { async send() {} },
    time: createCurrentTimeProvider("Asia/Shanghai"),
    getUserName: () => "Y",
    getDefaultTarget: () => ({ plugin: "feishu", sessionId: "session-1" })
  });

  const result = await tools.execute({
    id: "call_range",
    toolName: "check_chat",
    input: { scope: "range", from: "2026-05-24T01:00:00.000Z", to: "2026-05-24T02:00:00.000Z" }
  });
  assert.equal(result.ok, true);
  assert.match(String(result.output), /<chat-log>\n\[2026-05-24 09:00:00\]\n\{\{user\}\}:inside range\n<\/chat-log>/);
  assert.match(formatToolResultForLLM(result, { user: "Y" }), /<chat-log>\n\[2026-05-24 09:00:00\]\nY:inside range\n<\/chat-log>/);
  assert.doesNotMatch(String(result.output), /before range|after range/);
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
    getSleepCocoonEnteredAt: () => new Date(baseTime - 1000).toISOString(),
    getDefaultTarget: () => ({ plugin: "feishu", sessionId: "session-1" })
  });

  const recent = await tools.execute({ id: "call_1", toolName: "check_chat", input: {} });
  assert.equal(recent.ok, true);
  assert.match(String(recent.output), /hello today/);
  assert.match(String(recent.output), /hello from old session/);
  assert.match(String(recent.output), /hello from wechat/);
  assert.match(String(recent.output), /\{\{user\}\}:hello today/);
  assert.match(formatToolResultForLLM(recent, { user: "小王" }), /小王:hello today/);
  assert.match(String(recent.output), /Alice:hello back/);
  assert.match(String(recent.output), /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]\n\{\{user\}\}:hello today\nAlice:hello back/m);
  assert.doesNotMatch(String(recent.output), /\[(?:today|yesterday) /);
  assert.equal((String(recent.output).match(/^\[/gm) ?? []).length, 2);
  assert.doesNotMatch(String(recent.output), /\.\d{3}Z/);
  assert.match(String(recent.output), /^<chat-log>\n/);
  assert.match(String(recent.output), /\n<\/chat-log>\n<time>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}<\\time>$/);
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

test("check_chat returns current time from configured timezone provider", async () => {
  const store = createAliceStore(path.join(makeTempDir("messaging-current-time"), "alice.sqlite"));
  const tools = createMessagingTools({
    store,
    outputRouter: { async send() {} },
    time: createCurrentTimeProvider("Asia/Shanghai", () => new Date("2026-05-26T04:34:56.789Z")),
    getDefaultTarget: () => ({ plugin: "feishu", sessionId: "session-1" })
  });

  const result = await tools.execute({ id: "call_current_time", toolName: "check_chat", input: { scope: "new" } });

  assert.equal(result.ok, true);
  assert.match(String(result.output), /<time>2026-05-26T12:34:56\.789<\\time>$/);
});

test("check_chat today starts ten messages before sleep cocoon pointer and todayold keeps old anchor", async () => {
  const store = createAliceStore(path.join(makeTempDir("messaging-sleep-cocoon-today"), "alice.sqlite"));
  store.upsertInboundMessage({
    plugin: "feishu",
    externalMessageId: "om_old_anchor",
    conversationId: "session-1",
    senderId: "user-1",
    contentType: "text",
    contentText: "after old today anchor",
    createdAt: "2026-05-25T08:00:00.000"
  });
  for (let index = 1; index <= 10; index += 1) {
    store.upsertInboundMessage({
      plugin: "feishu",
      externalMessageId: `om_pre_sleep_${index}`,
      conversationId: "session-1",
      senderId: "user-1",
      contentType: "text",
      contentText: `pre sleep context ${index}`,
      createdAt: `2026-05-25T11:${String(index).padStart(2, "0")}:00.000`
    });
  }
  store.upsertInboundMessage({
    plugin: "feishu",
    externalMessageId: "om_after_sleep",
    conversationId: "session-1",
    senderId: "user-1",
    contentType: "text",
    contentText: "after sleep cocoon",
    createdAt: "2026-05-25T12:30:00.000"
  });
  const tools = createMessagingTools({
    store,
    outputRouter: { async send() {} },
    time: createCurrentTimeProvider("Asia/Shanghai", () => new Date("2026-05-25T06:00:00.000Z")),
    getSleepCocoonEnteredAt: () => "2026-05-25T12:00:00.000",
    getDefaultTarget: () => ({ plugin: "feishu", sessionId: "session-1" })
  });

  const today = await tools.execute({ id: "call_today", toolName: "check_chat", input: { scope: "today" } });
  assert.doesNotMatch(String(today.output), /after old today anchor/);
  assert.match(String(today.output), /pre sleep context 1/);
  assert.match(String(today.output), /pre sleep context 10/);
  assert.match(String(today.output), /after sleep cocoon/);

  const todayOld = await tools.execute({ id: "call_todayold", toolName: "check_chat", input: { scope: "todayold" } });
  assert.match(String(todayOld.output), /after old today anchor/);
  assert.match(String(todayOld.output), /after sleep cocoon/);

  const toolsWithoutSleepPointer = createMessagingTools({
    store,
    outputRouter: { async send() {} },
    time: createCurrentTimeProvider("Asia/Shanghai", () => new Date("2026-05-25T06:00:00.000Z")),
    getDefaultTarget: () => ({ plugin: "feishu", sessionId: "session-1" })
  });
  const todayWithoutSleepPointer = await toolsWithoutSleepPointer.execute({ id: "call_today_no_sleep", toolName: "check_chat", input: { scope: "today" } });
  assert.doesNotMatch(String(todayWithoutSleepPointer.output), /after old today anchor/);
  assert.doesNotMatch(String(todayWithoutSleepPointer.output), /after sleep cocoon/);
  assert.match(String(todayWithoutSleepPointer.output), /nothing new/);
});

test("check_chat from_prefix reads messages after injected cursor", async () => {
  const store = createAliceStore(path.join(makeTempDir("messaging-from-prefix"), "alice.sqlite"));
  store.upsertInboundMessage({
    plugin: "feishu",
    externalMessageId: "m_1",
    conversationId: "session-1",
    senderId: "user-1",
    contentType: "text",
    contentText: "before fixed prefix",
    createdAt: "2026-05-25T00:00:00.000Z"
  });
  const cursorMessageId = store.listMessages(10).at(-1)?.id ?? 0;
  store.upsertInboundMessage({
    plugin: "feishu",
    externalMessageId: "m_2",
    conversationId: "session-1",
    senderId: "user-1",
    contentType: "text",
    contentText: "after fixed prefix",
    createdAt: "2026-05-25T00:01:00.000Z"
  });
  const tools = createMessagingTools({
    store,
    time: createCurrentTimeProvider("UTC", () => new Date("2026-05-25T00:02:00.000Z")),
    outputRouter: { async send() {} },
    getDefaultTarget: () => ({ plugin: "feishu", sessionId: "session-1" })
  });

  const result = await tools.execute({
    id: "call_from_prefix",
    toolName: "check_chat",
    input: { scope: "from_prefix", __fromPrefixAfterMessageId: cursorMessageId }
  });

  assert.equal(result.ok, true);
  assert.equal(result.messageCursorId, cursorMessageId + 1);
  assert.doesNotMatch(String(result.output), /before fixed prefix/);
  assert.match(String(result.output), /after fixed prefix/);
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
    getSleepCocoonEnteredAt: () => "2026-05-26T00:00:00.000",
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
  assert.match(String(third.output), /^<chat-log>\nnothing new\n<\/chat-log>\n<time>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}<\\time>$/);

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
    getSleepCocoonEnteredAt: () => "2026-05-26T00:00:00.000",
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
    contentText: "[语音][0:0.020,0:5.000]  晚点见",
    contentJson: JSON.stringify({ kind: "audio", assetId: "voice-1.mp3", transcript: "[语音][0:0.020,0:5.000]  晚点见" }),
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
    getSleepCocoonEnteredAt: () => "2026-05-26T00:00:00.000",
    getDefaultTarget: () => ({ plugin: "feishu", sessionId: "session-1" })
  });

  const result = await tools.execute({ id: "call_media_records", toolName: "check_chat", input: {} });
  assert.equal(result.ok, true);
  assert.match(String(result.output), /Alice发送了一张图片/);
  assert.doesNotMatch(String(result.output), /Alice:发送了一张图片/);
  assert.match(String(result.output), /Alice:\[语音\]晚点见/);
  assert.doesNotMatch(String(result.output), /0:0\.020|0:5\.000/);
  assert.match(String(result.output), /Alice发送了文件\[report\.pdf\]/);
  assert.doesNotMatch(String(result.output), /Alice:发送了文件\[report\.pdf\]/);
  assert.doesNotMatch(String(result.output), /selfie_20260528_160956\.jpg/);
});

test("check_chat renders voicecalltranscript as an embedded transcript block", async () => {
  const store = createAliceStore(path.join(makeTempDir("messaging-voicecalltranscript"), "alice.sqlite"), {
    time: createCurrentTimeProvider("Asia/Tokyo", () => new Date("2026-06-06T15:01:00.000Z"))
  });
  const insertTranscript = (
    entryId: string,
    role: "system" | "assistant" | "user",
    contentText: string,
    createdAt: string,
    createdAtUtc: string
  ) => store.upsertInboundMessage({
    plugin: "webrtc_voice",
    externalMessageId: `voicecalltranscript:session-1:${entryId}`,
    conversationId: "call-1",
    senderRole: "system",
    contentType: "voicecalltranscript",
    contentText,
    contentJson: JSON.stringify({
      kind: "voicecalltranscript",
      talkSessionId: "session-1",
      entryId,
      role,
      durationMs: 20_000
    }),
    createdAt,
    createdAtUtc,
    coreProcessedAt: createdAt
  });
  insertTranscript("system:start", "system", "开始", "2026-06-07T00:00:00.000", "2026-06-06T15:00:00.000Z");
  insertTranscript("user:1", "user", "喂，爱丽丝，能听到吗？\n\n我刚到车站，想确认一下今晚的安排。", "2026-06-07T00:00:02.000", "2026-06-06T15:00:02.000Z");
  insertTranscript("assistant:1", "assistant", "听得到。\n\n今晚先去吃饭，然后回去把明天要用的东西收好。", "2026-06-07T00:00:06.000", "2026-06-06T15:00:06.000Z");
  store.upsertInboundMessage({
    plugin: "feishu",
    externalMessageId: "om_call_chat_1",
    conversationId: "feishu-session-1",
    senderId: "user-1",
    senderRole: "user",
    contentType: "text",
    contentText: "我刚才也发了一条飞书确认。",
    createdAt: "2026-06-07T00:00:08.000",
    createdAtUtc: "2026-06-06T15:00:08.000Z"
  });
  insertTranscript("user:2", "user", "好，那我二十分钟后到。你帮我记一下别忘了买水。", "2026-06-07T00:00:12.000", "2026-06-06T15:00:12.000Z");
  insertTranscript("assistant:2", "assistant", "记下了，路上慢点，到附近再给我发一条消息。", "2026-06-07T00:00:16.000", "2026-06-06T15:00:16.000Z");
  const outbound = store.insertOutboundMessage({
    plugin: "feishu",
    conversationId: "feishu-session-1",
    senderRole: "assistant",
    contentType: "text",
    contentText: "我在飞书里也提醒你买水了。",
    createdAt: "2026-06-07T00:00:18.000",
    createdAtUtc: "2026-06-06T15:00:18.000Z"
  });
  store.markOutboundMessageSent(outbound.id, "om_call_chat_2", "2026-06-06T15:00:18.000Z");
  insertTranscript("system:end", "system", "结束", "2026-06-07T00:00:20.000", "2026-06-06T15:00:20.000Z");

  const tools = createMessagingTools({
    store,
    time: createCurrentTimeProvider("Asia/Tokyo", () => new Date("2026-06-06T15:01:00.000Z")),
    outputRouter: { async send() {} },
    getSleepCocoonEnteredAt: () => "2026-06-07T00:00:00.000",
    getDefaultTarget: () => ({ plugin: "feishu", sessionId: "session-1" })
  });

  const result = await tools.execute({ id: "call_voicecalltranscript", toolName: "check_chat", input: {} });
  assert.equal(result.ok, true);
  assert.match(String(result.output), /<chat-log>\n<voice-call-transcript>\n\[2026-06-07 00:00:00\]\n-已接通-/);
  assert.match(String(result.output), /\{\{user\}\}:喂，爱丽丝，能听到吗？\n\{\{user\}\}:我刚到车站，想确认一下今晚的安排。\nAlice:听得到。\nAlice:今晚先去吃饭，然后回去把明天要用的东西收好。/);
  assert.match(String(result.output), /\[message\]\{\{user\}\}:我刚才也发了一条飞书确认。\n\{\{user\}\}:好，那我二十分钟后到。你帮我记一下别忘了买水。/);
  assert.match(String(result.output), /Alice:记下了，路上慢点，到附近再给我发一条消息。\n\[message\]Alice:我在飞书里也提醒你买水了。\n-已挂断-\n<call-duration>0:20<\/call-duration>\n<\/voice-call-transcript>\n<\/chat-log>/);
  assert.doesNotMatch(String(result.output), /\[message\]听得到|\[message\]记下了/);
  assert.doesNotMatch(String(result.output), /\{\{user\}\}:已挂断|\{\{user\}\}:-已挂断-/);
  assert.doesNotMatch(String(result.output), /Alice:<voice-call-transcript>|user:<voice-call-transcript>/);
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

  const recent = await tools.execute({ id: "call_recent", toolName: "check_chat", input: { scope: "recent" } });
  assert.equal(recent.ok, true);
  assert.doesNotMatch(String(recent.output), /msg 60\b/);
  assert.doesNotMatch(String(recent.output), /msg 510\b/);
  assert.match(String(recent.output), /msg 511\b/);
  assert.match(String(recent.output), /msg 560\b/);
  assert.equal((String(recent.output).match(/\{\{user\}\}:msg /g) ?? []).length, 50);
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
    getSleepCocoonEnteredAt: () => "2026-05-26T00:00:00.000",
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

  tools.noteLLMRequestStarted();
  await tools.execute({ id: "call_first", toolName: "check_chat", input: {} });
  const recentPreview = await tools.execute({
    id: "call_recent_preview",
    toolName: "check_chat",
    input: { __preview: true, __scope: "recent" }
  });
  assert.equal(recentPreview.ok, true);
  assert.match(String(recentPreview.output), /preview should not consume/);
  const next = await tools.execute({ id: "call_next", toolName: "check_chat", input: {} });
  assert.equal(next.ok, true);
  assert.doesNotMatch(String(next.output), /preview should not consume/);
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
  const beforeResult = await beforeSix.execute({ id: "call_before", toolName: "check_chat", input: { scope: "recent" } });
  assert.match(String(beforeResult.output), /prev evening/);
  assert.match(String(beforeResult.output), /today early/);

  const afterSix = createMessagingTools({
    store,
    time: createCurrentTimeProvider("Asia/Shanghai", () => new Date("2026-05-25T22:30:00.000Z")),
    outputRouter: { async send() {} },
    getDefaultTarget: () => ({ plugin: "feishu", sessionId: "session-1" })
  });
  const afterResult = await afterSix.execute({ id: "call_after", toolName: "check_chat", input: { scope: "recent" } });
  assert.match(String(afterResult.output), /prev evening/);
  assert.match(String(afterResult.output), /today early/);
});

test("check_chat chat labels use absolute local time", async () => {
  const store = createAliceStore(path.join(makeTempDir("messaging-injected-now"), "alice.sqlite"), {
    time: createCurrentTimeProvider("Asia/Shanghai")
  });
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
    getSleepCocoonEnteredAt: () => "2026-05-25T00:00:00.000",
    getDefaultTarget: () => ({ plugin: "feishu", sessionId: "session-1" })
  });

  const result = await tools.execute({ id: "call_time_label", toolName: "check_chat", input: {} });
  assert.match(String(result.output), /\[2026-05-25 23:30:00\]\n\{\{user\}\}:late yesterday/);
  assert.doesNotMatch(String(result.output), /\[(?:today|yesterday) /);
});

test("check_chat merges shell switch logs into chat context", async () => {
  const store = createAliceStore(path.join(makeTempDir("messaging-shell-switch"), "alice.sqlite"), {
    time: createCurrentTimeProvider("Asia/Shanghai")
  });
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
    getSleepCocoonEnteredAt: () => "2026-05-26T00:00:00.000",
    getDefaultTarget: () => ({ plugin: "feishu", sessionId: "session-1" }),
    getShellSwitchLogs: () => [{
      time: "2026-05-26T10:02:00.000Z",
      personalityName: "冷淡",
      relationshipName: "同桌",
      outfitName: "制服"
    }]
  });

  const result = await tools.execute({ id: "call_shell_switch", toolName: "check_chat", input: {} });
  assert.equal(result.ok, true);
  assert.match(String(result.output), /\{\{user\}\}:hello\n-壳切换:切换为冷淡的同桌爱丽丝-/);
  assert.doesNotMatch(String(result.output), /制服|服装/);
  assert.doesNotMatch(String(result.output), /system:/);
});

test("check_chat new scope does not return shell logs without unread messages", async () => {
  const store = createAliceStore(path.join(makeTempDir("messaging-shell-switch-no-new"), "alice.sqlite"));
  store.upsertInboundMessage({
    plugin: "feishu",
    externalMessageId: "om_1",
    conversationId: "session-1",
    senderId: "user-1",
    contentType: "text",
    contentText: "hello",
    createdAt: "2026-05-26T10:01:00.000"
  });

  const tools = createMessagingTools({
    store,
    time: createCurrentTimeProvider("Asia/Shanghai", () => new Date("2026-05-26T12:00:00.000Z")),
    outputRouter: { async send() {} },
    getSleepCocoonEnteredAt: () => "2026-05-26T00:00:00.000",
    getDefaultTarget: () => ({ plugin: "feishu", sessionId: "session-1" }),
    getShellSwitchLogs: () => [
      {
        time: "2026-05-26T09:00:00.000",
        personalityName: "冷淡",
        relationshipName: "同桌"
      }
    ]
  });

  tools.noteLLMRequestStarted();
  await tools.execute({ id: "call_recent", toolName: "check_chat", input: {} });
  const result = await tools.execute({ id: "call_new", toolName: "check_chat", input: {} });

  assert.equal(result.ok, true);
  assert.match(String(result.output), /^<chat-log>\nnothing new\n<\/chat-log>\n<time>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}<\\time>$/);
  assert.doesNotMatch(String(result.output), /壳切换/);
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
  store.upsertInboundMessage({
    plugin: "feishu",
    externalMessageId: "old_1",
    conversationId: "session-1",
    senderRole: "user",
    contentType: "text",
    contentText: "old context should not come back from send_chat",
    createdAt: "2026-05-25T23:59:00.000Z"
  });
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
    getSleepCocoonEnteredAt: () => "2026-05-25T00:00:00.000",
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
  assert.doesNotMatch(String(result.output), /old context should not come back from send_chat/);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map((output) => output.content.kind === "text" ? output.content.text : ""), ["one", "two"]);
  const stored = store.listMessagesForConversation("session-1", 10).filter((message) => message.direction === "outbound");
  assert.equal(stored.length, 2);
  assert.deepEqual(stored.map((message) => message.externalMessageId), ["sent_1", "sent_2"]);

  const noNew = await tools.execute({ id: "call_check_new", toolName: "check_chat", input: {} });
  assert.equal(noNew.ok, true);
  assert.match(String(noNew.output), /^<chat-log>\nnothing new\n<\/chat-log>\n<time>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}<\\time>$/);
});

test("send_chat filters parenthetical text before sending and storing", async () => {
  const store = createAliceStore(path.join(makeTempDir("messaging-send-filter-parentheses"), "alice.sqlite"));
  const sent: AgentOutput[] = [];
  const tools = createMessagingTools({
    store,
    sleep: async () => {},
    outputRouter: {
      async send(output) {
        sent.push(output);
        return { messageId: `sent_${sent.length}` };
      }
    },
    getDefaultTarget: () => ({ plugin: "wechat", userId: "wx-user", sessionId: "wechat:dm:wx-user" })
  });

  const result = await tools.execute({
    id: "call_send_filter_parentheses",
    toolName: "send_chat",
    input: { type: "message", content: "one(不发送)\n(整行不发送)\ntwo（也不发送）" }
  });
  const emptyResult = await tools.execute({
    id: "call_send_filter_parentheses_empty",
    toolName: "send_chat",
    input: { type: "message", content: "(只是一段旁白)" }
  });

  assert.equal(result.ok, true);
  assert.equal(emptyResult.ok, false);
  assert.equal(emptyResult.error, "content is required");
  assert.deepEqual(sent.map((output) => output.content.kind === "text" ? output.content.text : ""), ["one", "two"]);
  const stored = store.listMessagesForConversation("wechat:dm:wx-user", 10).filter((message) => message.direction === "outbound");
  assert.deepEqual(stored.map((message) => message.contentText), ["one", "two"]);
});

test("send_chat filters DSML markup lines before sending and storing", async () => {
  const store = createAliceStore(path.join(makeTempDir("messaging-send-filter-dsml"), "alice.sqlite"));
  const sent: AgentOutput[] = [];
  const tools = createMessagingTools({
    store,
    sleep: async () => {},
    outputRouter: {
      async send(output) {
        sent.push(output);
        return { messageId: `sent_${sent.length}` };
      }
    },
    getDefaultTarget: () => ({ plugin: "feishu", userId: "ou-user", sessionId: "feishu:dm:ou-user" })
  });

  const result = await tools.execute({
    id: "call_send_filter_dsml",
    toolName: "send_chat",
    input: { type: "message", content: "one\n<｜｜DSML｜｜parameter name=\"type\" string=\"true\">message\ntwo" }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(sent.map((output) => output.content.kind === "text" ? output.content.text : ""), ["one", "two"]);
  const stored = store.listMessagesForConversation("feishu:dm:ou-user", 10).filter((message) => message.direction === "outbound");
  assert.deepEqual(stored.map((message) => message.contentText), ["one", "two"]);
});

test("messaging tools prepare voice synthesizer when llm request starts", async () => {
  let prepareCalls = 0;
  const tools = createMessagingTools({
    store: createAliceStore(path.join(makeTempDir("messaging-tts-prepare"), "alice.sqlite")),
    outputRouter: { async send() {} },
    getDefaultTarget: () => ({ plugin: "feishu", sessionId: "session-1" }),
    voiceSynthesizer: Object.assign(async () => {
      throw new Error("not used");
    }, {
      async prepare() {
        prepareCalls += 1;
      }
    })
  });

  tools.noteLLMRequestStarted();
  await Promise.resolve();
  assert.equal(prepareCalls, 1);
});

test("send_chat voice synthesizes text, sends audio, and removes generated file", async () => {
  const dir = makeTempDir("messaging-send-voice");
  const store = createAliceStore(path.join(dir, "alice.sqlite"));
  const sent: AgentOutput[] = [];
  let generatedPath = "";
  const trainingDir = path.join(dir, "tts-training", "voice-massage");
  const tools = createMessagingTools({
    store,
    time: createCurrentTimeProvider("UTC", () => new Date("2026-05-26T00:00:00.000Z")),
    sleep: async () => {},
    voiceMessageTtsTrainingOutputDir: trainingDir,
    voiceSynthesizer: async ({ text }) => {
      generatedPath = path.join(dir, "voice.wav");
      fs.writeFileSync(generatedPath, `voice:${text}`);
      return { assetId: "generated/tts/voice.wav", filePath: generatedPath };
    },
    outputRouter: {
      async send(output) {
        sent.push(output);
        assert.equal(fs.existsSync(generatedPath), true);
        return { messageId: "voice_1" };
      }
    },
    getDefaultTarget: () => ({ plugin: "wechat", userId: "wx-user", sessionId: "wechat:dm:wx-user" })
  });

  const result = await tools.execute({
    id: "call_send_voice",
    toolName: "send_chat",
    input: { type: "voice", content: "晚点见" }
  });

  assert.equal(result.ok, true);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].content, { kind: "audio", assetId: "generated/tts/voice.wav", transcript: "晚点见" });
  assert.equal(fs.existsSync(generatedPath), false);
  const trainingFiles = fs.readdirSync(trainingDir).sort();
  assert.equal(trainingFiles.length, 2);
  const audioFileName = trainingFiles.find((fileName) => fileName.endsWith(".wav"));
  assert.ok(audioFileName);
  const audioFilePath = path.join(trainingDir, audioFileName);
  assert.equal(fs.readFileSync(audioFilePath, "utf8"), "voice:晚点见");
  const metadata = JSON.parse(fs.readFileSync(`${audioFilePath}.json`, "utf8"));
  assert.equal(metadata.text, "晚点见");
  assert.equal(metadata.status, "sent");
  assert.equal(metadata.plugin, "wechat");
  assert.equal(metadata.sessionId, "wechat:dm:wx-user");
  assert.equal(metadata.assetId, "generated/tts/voice.wav");
  assert.match(String(result.output), /Alice:\[语音\]晚点见/);
  const stored = store.listMessagesForConversation("wechat:dm:wx-user", 10).filter((message) => message.direction === "outbound");
  assert.equal(stored.length, 1);
  assert.equal(stored[0].contentType, "audio");
  assert.equal(stored[0].externalMessageId, "voice_1");
});

test("tts plugin translates before tts while preserving original send_chat voice transcript", async () => {
  const dir = makeTempDir("messaging-tts");
  const store = createAliceStore(path.join(dir, "alice.sqlite"));
  const sent: AgentOutput[] = [];
  const synthesizedTexts: string[] = [];
  const llmMessages: Array<{ role: string; content: string }> = [];
  const llmAgents: string[] = [];
  let generatedPath = "";
  const voiceSynthesizer = createTtsTranslationSynthesizer({
    enabled: true,
    translationEnabled: true,
    api_preset: {
      baseURL: "https://example.invalid/v1",
      apiKey: "test-key",
      model: "flash",
      temperature: 0,
      timeoutMs: 1000,
      extraParams: {}
    },
    prompt: "Translate to Japanese.\nText:"
  }, {
    baseSynthesizer: async ({ text }) => {
      synthesizedTexts.push(text);
      generatedPath = path.join(dir, "voice.wav");
      fs.writeFileSync(generatedPath, `voice:${text}`);
      return { assetId: "generated/tts/voice.wav", filePath: generatedPath };
    },
    llmRequestSender: async (input) => {
      llmAgents.push(input.agentId);
      llmMessages.push(...input.messages.map((message) => ({ role: message.role, content: message.content })));
      return { message: { role: "assistant", content: "また後で会いましょう" } };
    },
    llm: {
      async chat(input) {
        llmMessages.push(...input.messages.map((message) => ({ role: message.role, content: message.content })));
        return { message: { role: "assistant", content: "direct chat should not be used" } };
      }
    }
  });
  const tools = createMessagingTools({
    store,
    time: createCurrentTimeProvider("UTC", () => new Date("2026-05-26T00:00:00.000Z")),
    sleep: async () => {},
    voiceSynthesizer,
    outputRouter: {
      async send(output) {
        sent.push(output);
        return { messageId: "voice_1" };
      }
    },
    getDefaultTarget: () => ({ plugin: "wechat", userId: "wx-user", sessionId: "wechat:dm:wx-user" })
  });

  const result = await tools.execute({
    id: "call_send_voice_japanese",
    toolName: "send_chat",
    input: { type: "voice", content: "晚点见" }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(llmAgents, ["tts"]);
  assert.deepEqual(llmMessages, [
    { role: "system", content: "Translate to Japanese.\nText:" },
    { role: "user", content: "晚点见" }
  ]);
  assert.deepEqual(synthesizedTexts, ["また後で会いましょう"]);
  assert.deepEqual(sent[0].content, { kind: "audio", assetId: "generated/tts/voice.wav", transcript: "晚点见" });
  assert.match(String(result.output), /Alice:\[语音\]晚点见/);
  assert.doesNotMatch(String(result.output), /また後で会いましょう/);
});

test("tts plugin can skip translation and send original text to jp tts", async () => {
  const dir = makeTempDir("messaging-tts-no-translate");
  const synthesizedTexts: string[] = [];
  let llmCalls = 0;
  const voiceSynthesizer = createTtsTranslationSynthesizer({
    enabled: true,
    translationEnabled: false,
    api_preset: {
      baseURL: "",
      model: "flash"
    },
    prompt: "Translate to Japanese.\nText:"
  }, {
    baseSynthesizer: async ({ text }) => {
      synthesizedTexts.push(text);
      const filePath = path.join(dir, "voice.wav");
      fs.writeFileSync(filePath, `voice:${text}`);
      return { assetId: "generated/tts/voice.wav", filePath };
    },
    llmRequestSender: async () => {
      llmCalls += 1;
      return { message: { role: "assistant", content: "日本語" } };
    }
  });

  await voiceSynthesizer({ text: "原文", time: createCurrentTimeProvider("UTC") });

  assert.equal(llmCalls, 0);
  assert.deepEqual(synthesizedTexts, ["原文"]);
});

test("tts plugin config reads switch, api preset, and prompt from plugin folder config", () => {
  const dir = makeTempDir("tts-config");
  const configPath = path.join(dir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    enabled: true,
    translationPresetName: "default",
    translationPresets: {
      default: {
        translationEnabled: true,
        apiPresetName: "fixed-flash",
        prompt: "Translate to Japanese.\nText:"
      }
    },
    voice: {
      modelConfigName: "jp",
      modelConfigs: {
        jp: { language: "jp", speed: 1.15, splitText: false }
      }
    }
  }));

  const config = readTtsPluginConfig(configPath);

  assert.equal(config.enabled, true);
  assert.equal(config.translationEnabled, true);
  assert.equal(config.apiPresetName, "fixed-flash");
  assert.equal(config.api_preset?.apiKey, undefined);
  assert.equal(config.api_preset?.baseURL, "");
  assert.equal(config.prompt, "Translate to Japanese.\nText:");
  assert.equal(config.voice?.modelConfigs?.jp?.splitText, false);
});

test("tts plugin config migrates legacy remote settings into Genie conversion", () => {
  const dir = makeTempDir("tts-config-conversion");
  const configPath = path.join(dir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    enabled: true,
    remote: {
      enabled: true,
      baseURL: "192.168.0.103"
    },
    translationEnabled: false,
    prompt: "Read aloud."
  }));

  const config = readTtsPluginConfig(configPath);

  assert.equal(config.conversion?.provider, "genie");
  assert.equal(config.conversion?.genie?.enabled, true);
  assert.equal(config.conversion?.genie?.baseURL, "http://192.168.0.103:8767");
  assert.equal(config.remote?.baseURL, "http://192.168.0.103:8767");
});

test("tts plugin switch is read from plugin config at synthesis time", async () => {
  const dir = makeTempDir("tts-switch");
  const configPath = path.join(dir, "config.json");
  const synthesizedTexts: string[] = [];
  const writeConfig = (enabled: boolean) => fs.writeFileSync(configPath, JSON.stringify({
    enabled,
    apiPresetName: "fixed-flash",
    prompt: "Translate to Japanese.\nText:"
  }));
  writeConfig(false);
  const plugin = createTtsPlugin({
    configPath,
    baseSynthesizer: async ({ text }) => {
      synthesizedTexts.push(text);
      const filePath = path.join(dir, `${synthesizedTexts.length}.wav`);
      fs.writeFileSync(filePath, text);
      return { assetId: `generated/tts/${synthesizedTexts.length}.wav`, filePath };
    },
    llm: {
      async chat() {
        return { message: { role: "assistant", content: "日本語" } };
      }
    },
    resolveApiPreset(name) {
      assert.equal(name, "fixed-flash");
      return {
        name,
        baseURL: "https://example.invalid/v1",
        apiKey: "test-key",
        model: "flash"
      };
    }
  });

  await plugin.voiceSynthesizer({ text: "原文", time: createCurrentTimeProvider("UTC") });
  writeConfig(true);
  await plugin.voiceSynthesizer({ text: "原文", time: createCurrentTimeProvider("UTC") });

  assert.deepEqual(synthesizedTexts, ["原文", "日本語"]);
});

test("openai-api tts sends pcm speech request and maps PCM chunks to punctuation text", async () => {
  const requests: Array<{ url: string; body: any; authorization: string | null }> = [];
  const outputDir = path.join(makeTempDir("openai-api-tts-output"), "assets", "generated", "tts");
  const first = new Uint8Array(32_000 * 2);
  const second = new Uint8Array(32_000 * 2);
  second.fill(1);
  const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(url),
      body: JSON.parse(String(init?.body)),
      authorization: init?.headers instanceof Headers ? init.headers.get("authorization") : (init?.headers as Record<string, string>)?.authorization ?? null
    });
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(first);
        controller.enqueue(second);
        controller.close();
      }
    }), { status: 200, headers: { "content-type": "application/octet-stream" } });
  };
  const synthesize = createOpenAiApiTtsVoiceSynthesizer({
    enabled: true,
    translationEnabled: false,
    prompt: "Read aloud.",
    conversion: {
      provider: "openai-api",
      openaiApi: {
        apiPresetName: "speech",
        model: "higgs-audio-v3-tts",
        voice: "default",
        sampleRate: 16_000,
        channels: 1
      }
    }
  }, {
    outputDir,
    fetch: fakeFetch as typeof fetch,
    resolveApiPreset(name) {
      assert.equal(name, "speech");
      return {
        name,
        baseURL: "https://api.boson.ai/v1",
        apiKey: "test-key",
        model: "preset-model"
      };
    }
  });

  const chunks = [];
  for await (const chunk of synthesize.streamAudioWithText!({
    text: "第一句。第二句。",
    time: createCurrentTimeProvider("UTC")
  })) {
    chunks.push([chunk.text, chunk.chunk.byteLength, chunk.sampleRateHz, chunk.channels]);
  }

  assert.equal(requests[0].url, "https://api.boson.ai/v1/audio/speech");
  assert.equal(requests[0].authorization, "Bearer test-key");
  assert.deepEqual(requests[0].body, {
    input: "第一句。第二句。",
    model: "higgs-audio-v3-tts",
    voice: "default",
    response_format: "pcm",
    stream: true
  });
  assert.deepEqual(chunks, [
    ["第一句。", 64_000, 16_000, 1],
    ["第二句。", 64_000, 16_000, 1]
  ]);

  const result = await synthesize({
    text: "保存音频。",
    time: createCurrentTimeProvider("UTC", () => new Date("2026-06-09T02:10:51.609Z"))
  });
  try {
    assert.equal(result.assetId, "generated/tts/2026-06-09T02_10_51.609-openai-api.wav");
    assert.equal(result.filePath, path.join(outputDir, "2026-06-09T02_10_51.609-openai-api.wav"));
    assert.equal(fs.existsSync(result.filePath), true);
    assert.equal(path.resolve(outputDir, path.basename(result.assetId)), path.resolve(result.filePath));
    const wav = fs.readFileSync(result.filePath);
    assert.equal(new DataView(wav.buffer, wav.byteOffset, wav.byteLength).getUint32(24, true), 16_000);
    assert.equal(requests[1].body.response_format, "pcm");
    assert.equal("stream" in requests[1].body, false);
  } finally {
    fs.rmSync(result.filePath, { force: true });
  }
});

test("tts PCM progress mapper falls back to UTF character slices without punctuation", () => {
  const mapper = createTtsPcmProgressTextMapper("abcdef", 6, { sampleRate: 1000, channels: 1, bytesPerSample: 1 });

  assert.equal(mapper.take(2), "ab");
  assert.equal(mapper.take(2), "cd");
  assert.equal(mapper.take(2), "ef");
});

test("tts stream translates the full conversation once and yields Genie audio chunks", async () => {
  const dir = makeTempDir("tts-stream");
  const configPath = path.join(dir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    enabled: true,
    apiPresetName: "fixed-flash",
    prompt: "Translate to Japanese.\nText:",
    voice: {
      splitText: true
    }
  }));
  const translatedInputs: string[] = [];
  const streamedTexts: string[] = [];
  const streamedGenie: unknown[] = [];
  const logs: string[] = [];
  const plugin = createTtsPlugin({
    configPath,
    baseSynthesizer: Object.assign(async () => {
      throw new Error("non-stream synthesizer should not be used");
    }, {
      async *streamAudio({ text, genie }: { text: string; genie?: unknown }) {
        streamedTexts.push(text);
        streamedGenie.push(genie);
        yield new Uint8Array([streamedTexts.length, 1]);
        yield new Uint8Array([streamedTexts.length, 2]);
      }
    }),
    llmRequestSender: async (input) => {
      const text = String(input.messages.at(-1)?.content ?? "");
      translatedInputs.push(text);
      return { message: { role: "assistant", content: `ja:${translatedInputs.length}` } };
    },
    resolveApiPreset() {
      return {
        baseURL: "https://example.invalid/v1",
        apiKey: "test-key",
        model: "flash"
      };
    },
    appendLog: (_level, message) => logs.push(message)
  });

  const events = [];
  for await (const event of plugin.voiceSynthesizer.stream!({
    text: ["第一句第一句啊。", "第二句第二句啊。"],
    time: createCurrentTimeProvider("UTC"),
    source: "send_chat.voice",
    streamId: "stream-1"
  })) {
    events.push(event);
  }

  assert.deepEqual(translatedInputs, ["第一句第一句啊。第二句第二句啊。"]);
  assert.deepEqual(streamedTexts, ["ja:1"]);
  assert.equal(streamedGenie.every((genie: any) => genie?.speed === undefined && genie?.splitText === true), true);
  assert.deepEqual(events.map((event) => event.type), [
    "translation_started",
    "translation_done",
    "audio",
    "audio",
    "part_done",
    "done"
  ]);
  assert.deepEqual(events.filter((event) => event.type === "audio").map((event: any) => [event.sequence, Array.from(event.chunk)]), [
    [0, [1, 1]],
    [0, [1, 2]]
  ]);
  assert.equal(logs.some((message) => message.includes("tts stream tts complete") && message.includes("chunks=2")), true);
});

test("tts stream maps returned translated audio text back to source punctuation", async () => {
  const dir = makeTempDir("tts-stream-source-text");
  const configPath = path.join(dir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    enabled: true,
    apiPresetName: "fixed-flash",
    prompt: "Translate to Japanese.\nText:"
  }));
  const plugin = createTtsPlugin({
    configPath,
    baseSynthesizer: Object.assign(async () => {
      throw new Error("non-stream synthesizer should not be used");
    }, {
      async *streamAudioWithText() {
        yield { text: "これは一文目です。", chunk: new Uint8Array([1, 2]) };
        yield { text: "二文目です。", chunk: new Uint8Array([3, 4]) };
      },
      async *streamAudio() {
        throw new Error("streamAudio should not be used when streamAudioWithText is available");
      }
    }),
    llmRequestSender: async () => ({
      message: { role: "assistant", content: "これは一文目です。二文目です。" }
    }),
    resolveApiPreset() {
      return {
        baseURL: "https://example.invalid/v1",
        apiKey: "test-key",
        model: "flash"
      };
    }
  });

  const events = [];
  for await (const event of plugin.voiceSynthesizer.stream!({
    text: "第一句。第二句。",
    time: createCurrentTimeProvider("UTC"),
    source: "send_chat.voice"
  })) {
    events.push(event);
  }

  assert.deepEqual(events.filter((event) => event.type === "audio").map((event: any) => [event.text, Array.from(event.chunk)]), [
    ["第一句。", [1, 2]],
    ["第二句。", [3, 4]]
  ]);
});

test("tts stream returns original text with symbol-length silence for symbol-only input", async () => {
  const dir = makeTempDir("tts-stream-symbol-only");
  const configPath = path.join(dir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    enabled: true,
    apiPresetName: "fixed-flash",
    prompt: "Translate to Japanese.\nText:"
  }));
  let llmCalls = 0;
  let streamCalls = 0;
  const logs: string[] = [];
  const plugin = createTtsPlugin({
    configPath,
    baseSynthesizer: Object.assign(async () => {
      throw new Error("non-stream synthesizer should not be used");
    }, {
      async *streamAudioWithText() {
        streamCalls += 1;
        yield { text: "should not stream", chunk: new Uint8Array([1]) };
      }
    }),
    llmRequestSender: async () => {
      llmCalls += 1;
      return { message: { role: "assistant", content: "日本語" } };
    },
    resolveApiPreset() {
      return {
        baseURL: "https://example.invalid/v1",
        apiKey: "test-key",
        model: "flash"
      };
    },
    appendLog: (_level, message) => logs.push(message)
  });

  const events = [];
  for await (const event of plugin.voiceSynthesizer.stream!({
    text: "！？…",
    time: createCurrentTimeProvider("UTC"),
    source: "send_chat.voice",
    streamId: "symbol-stream"
  })) {
    events.push(event);
  }

  assert.equal(llmCalls, 0);
  assert.equal(streamCalls, 0);
  assert.deepEqual(events.map((event) => event.type), ["audio", "part_done", "done"]);
  assert.equal((events[0] as any).text, "！？…");
  assert.equal((events[0] as any).chunk.byteLength, 3 * 100 * 64);
  assert.equal((events[0] as any).chunk.every((value: number) => value === 0), true);
  assert.equal(logs.some((message) => message.includes("symbol-only input") && message.includes("symbols=3")), true);
});

test("tts streamAudioWithText returns symbol-only input as original text and silence", async () => {
  let streamCalls = 0;
  const synthesize = createTtsTranslationSynthesizer({
    enabled: true,
    translationEnabled: true,
    api_preset: {
      baseURL: "https://example.invalid/v1",
      apiKey: "test-key",
      model: "flash"
    },
    prompt: "Translate to Japanese.\nText:"
  }, {
    baseSynthesizer: Object.assign(async () => {
      throw new Error("non-stream synthesizer should not be used");
    }, {
      async *streamAudioWithText() {
        streamCalls += 1;
        yield { text: "should not stream", chunk: new Uint8Array([1]) };
      }
    })
  });

  const chunks = [];
  for await (const chunk of synthesize.streamAudioWithText!({
    text: "!!!",
    time: createCurrentTimeProvider("UTC")
  })) {
    chunks.push(chunk);
  }

  assert.equal(streamCalls, 0);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].text, "!!!");
  assert.equal(chunks[0].chunk.byteLength, 3 * 100 * 64);
  assert.equal(chunks[0].chunk.every((value) => value === 0), true);
});

test("tts stream never hard-cuts source text between punctuation boundaries", async () => {
  const dir = makeTempDir("tts-stream-no-hard-cut");
  const configPath = path.join(dir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    enabled: true,
    apiPresetName: "fixed-flash",
    prompt: "Translate to Japanese.\nText:"
  }));
  const plugin = createTtsPlugin({
    configPath,
    baseSynthesizer: Object.assign(async () => {
      throw new Error("non-stream synthesizer should not be used");
    }, {
      async *streamAudioWithText() {
        yield { text: "老板から返信があるか", chunk: new Uint8Array([1]) };
        yield { text: "確認してるんだよ！", chunk: new Uint8Array([2]) };
      }
    }),
    llmRequestSender: async () => ({
      message: { role: "assistant", content: "老板から返信があるか確認してるんだよ！" }
    }),
    resolveApiPreset() {
      return {
        baseURL: "https://example.invalid/v1",
        apiKey: "test-key",
        model: "flash"
      };
    }
  });

  const events = [];
  for await (const event of plugin.voiceSynthesizer.stream!({
    text: "着手机看老板有没有回消息呢！",
    time: createCurrentTimeProvider("UTC"),
    source: "send_chat.voice"
  })) {
    events.push(event);
  }

  assert.deepEqual(events.filter((event) => event.type === "audio").map((event: any) => event.text), [
    "着手机看老板有没有回消息呢！",
    undefined
  ]);
});

test("tts stream text collection preserves full conversation order", async () => {
  const text = await collectTtsStreamText(["第一句", "。", "第二句"]);
  assert.equal(text, "第一句。第二句");
});

test("tts passes Genie language and plugin voice assets as per-request overrides", () => {
  const overrides = ttsGenieOverrides({
    enabled: true,
    translationEnabled: true,
    apiPresetName: "fixed-flash",
    api_preset: {
      baseURL: "",
      model: "flash"
    },
    prompt: "Translate to Japanese.\nText:",
    voice: {
      modelConfigName: "jp-unit-no-assets",
      modelConfigs: {
        "jp-unit-no-assets": {
          language: "jp",
          speed: 1.15,
          partSilenceSeconds: 0.35,
          splitText: false
        }
      }
    }
  });

  assert.deepEqual(overrides, {
    language: "jp",
    modelDir: "assets/tts/preset/jp-unit-no-assets/model",
    referenceAudio: undefined,
    referenceText: undefined,
    speed: 1.15,
    partSilenceSeconds: 0.35,
    splitText: false
  });
});

test("tts passes configured voice language to Genie overrides", () => {
  const overrides = ttsGenieOverrides({
    enabled: true,
    translationEnabled: false,
    api_preset: {
      baseURL: "",
      model: "flash"
    },
    prompt: "Read aloud.",
    voice: {
      modelConfigName: "zh-main",
      modelConfigs: {
        "zh-main": {
          language: "zh"
        }
      }
    }
  });

  assert.equal(overrides.language, "zh");
  assert.equal(overrides.modelDir, "assets/tts/preset/zh-main/model");
});


test("send_chat voice sends bracketed transcript text on feishu", async () => {
  const dir = makeTempDir("messaging-send-voice-feishu-transcript");
  const store = createAliceStore(path.join(dir, "alice.sqlite"));
  const sent: AgentOutput[] = [];
  const logs: Array<{ status?: string; summary: string }> = [];
  let generatedPath = "";
  const tools = createMessagingTools({
    store,
    time: createCurrentTimeProvider("UTC", () => new Date("2026-05-26T00:00:00.000Z")),
    sleep: async () => {},
    voiceSynthesizer: async ({ text }) => {
      generatedPath = path.join(dir, "voice.wav");
      fs.writeFileSync(generatedPath, `voice:${text}`);
      return { assetId: "generated/tts/voice.wav", filePath: generatedPath };
    },
    outputRouter: {
      async send(output) {
        sent.push(output);
        return { messageId: `sent_${sent.length}` };
      }
    },
    appendMessageLog(input) {
      logs.push({ status: input.status, summary: input.summary });
    },
    getDefaultTarget: () => ({ plugin: "feishu", channelId: "oc_1", sessionId: "feishu:dm:oc_1" })
  });

  const result = await tools.execute({
    id: "call_send_voice_feishu_transcript",
    toolName: "send_chat",
    input: { type: "voice", content: "晚点见" }
  });

  assert.equal(result.ok, true);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0].content, { kind: "audio", assetId: "generated/tts/voice.wav", transcript: "晚点见" });
  assert.deepEqual(sent[1].content, { kind: "text", text: "[晚点见]" });
  assert.equal(fs.existsSync(generatedPath), false);
  assert.match(String(result.output), /Alice:\[语音\]晚点见/);
  assert.doesNotMatch(String(result.output), /Alice:\[晚点见\]/);
  const stored = store.listMessagesForConversation("feishu:dm:oc_1", 10).filter((message) => message.direction === "outbound");
  assert.equal(stored.length, 1);
  assert.deepEqual(stored.map((message) => message.contentText), ["[语音]晚点见"]);
  assert.deepEqual(logs, [{ status: "sent", summary: "[语音]晚点见" }]);
});

test("send_chat voice retries feishu transcript without storing it", async () => {
  const dir = makeTempDir("messaging-send-voice-feishu-transcript-retry");
  const store = createAliceStore(path.join(dir, "alice.sqlite"));
  const sent: AgentOutput[] = [];
  const logs: Array<{ status?: string; summary: string }> = [];
  const warnings: string[] = [];
  let generatedPath = "";
  let transcriptAttempts = 0;
  const tools = createMessagingTools({
    store,
    time: createCurrentTimeProvider("UTC", () => new Date("2026-05-26T00:00:00.000Z")),
    sleep: async () => {},
    voiceSynthesizer: async ({ text }) => {
      generatedPath = path.join(dir, "voice.wav");
      fs.writeFileSync(generatedPath, `voice:${text}`);
      return { assetId: "generated/tts/voice.wav", filePath: generatedPath };
    },
    outputRouter: {
      async send(output) {
        sent.push(output);
        if (output.content.kind === "text") {
          transcriptAttempts += 1;
          if (transcriptAttempts === 1) throw new Error("temporary feishu failure");
        }
        return { messageId: `sent_${sent.length}` };
      }
    },
    appendMessageLog(input) {
      logs.push({ status: input.status, summary: input.summary });
    },
    appendLog(level, message) {
      if (level === "warn") warnings.push(message);
    },
    getDefaultTarget: () => ({ plugin: "feishu", channelId: "oc_1", sessionId: "feishu:dm:oc_1" })
  });

  const result = await tools.execute({
    id: "call_send_voice_feishu_transcript_retry",
    toolName: "send_chat",
    input: { type: "voice", content: "晚点见" }
  });

  assert.equal(result.ok, true);
  assert.equal(transcriptAttempts, 2);
  assert.equal(sent.length, 3);
  assert.deepEqual(sent.map((output) => output.content.kind), ["audio", "text", "text"]);
  assert.equal(fs.existsSync(generatedPath), false);
  const stored = store.listMessagesForConversation("feishu:dm:oc_1", 10).filter((message) => message.direction === "outbound");
  assert.equal(stored.length, 1);
  assert.deepEqual(stored.map((message) => message.contentText), ["[语音]晚点见"]);
  assert.deepEqual(logs, [{ status: "sent", summary: "[语音]晚点见" }]);
  assert.deepEqual(warnings, []);
});

test("moss onnx voice synthesizer calls service and returns opus asset", async () => {
  const calls: string[] = [];
  const dir = makeTempDir("moss-onnx-voice");
  const outputDir = "generated/tts";
  const fakeFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const pathname = new URL(String(url)).pathname;
    calls.push(`${init?.method ?? "GET"} ${pathname}`);
    if (pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, ready: true }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (pathname === "/synthesize") {
      const body = JSON.parse(String(init?.body)) as { outputPath: string };
      fs.mkdirSync(path.dirname(body.outputPath), { recursive: true });
      fs.writeFileSync(body.outputPath, "wav");
      return new Response(JSON.stringify({ ok: true, audioPath: body.outputPath, sampleRate: 48000, durationSeconds: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ ok: false }), { status: 404 });
  };
  const fakeSpawn = ((command: string, args: readonly string[]) => {
    const child = new events.EventEmitter() as any;
    child.stdout = new events.EventEmitter();
    child.stderr = new events.EventEmitter();
    child.exitCode = null;
    process.nextTick(() => {
      if (command === "ffmpeg") {
        if (args.includes("-f") && args.includes("s16le") && String(args[args.length - 1]) === "-") {
          const pcm = new Uint8Array(2000);
          for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
            pcm[offset] = 0xff;
            pcm[offset + 1] = 0x3f;
          }
          child.stdout.emit("data", pcm);
        } else {
          const outputPath = String(args[args.length - 1]);
          fs.writeFileSync(outputPath, "opus");
        }
      }
      child.emit("exit", 0, null);
    });
    return child;
  }) as any;
  const synthesize = createMossOnnxVoiceSynthesizer({
    backend: "moss-onnx",
    mossBaseURL: "http://127.0.0.1:9876",
    mossReferenceAudio: "test.opus",
    mossOutputDir: outputDir,
    assetRoot: path.join(dir, "assets"),
    mossTimeoutMs: 1_000,
    mossIdleShutdownMs: 0,
    mossFfmpegCommand: "ffmpeg"
  }, { fetch: fakeFetch as typeof fetch, spawn: fakeSpawn });

  const result = await synthesize({ text: "晚点见", time: createCurrentTimeProvider("UTC", () => new Date("2026-05-26T00:00:00.000Z")) });

  assert.match(result.assetId, /^generated\/tts\/20260526_000000_000\.opus$/);
  assert.equal(fs.existsSync(result.filePath), true);
  assert.equal(fs.readFileSync(result.filePath, "utf8"), "opus");
  assert.deepEqual(calls, ["GET /health", "POST /synthesize"]);
  await fsp.unlink(result.filePath);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("moss onnx voice synthesizer does not spawn when explicit base url is unhealthy", async () => {
  let spawnCalls = 0;
  const fakeFetch = async (): Promise<Response> => new Response(JSON.stringify({ ok: false }), { status: 503 });
  const fakeSpawn = (() => {
    spawnCalls += 1;
    throw new Error("spawn should not be called");
  }) as any;
  const synthesize = createMossOnnxVoiceSynthesizer({
    backend: "moss-onnx",
    mossBaseURL: "http://127.0.0.1:9876",
    mossBaseURLExplicit: true,
    mossReferenceAudio: "test.opus",
    mossOutputDir: "generated/tts",
    assetRoot: path.join(makeTempDir("tts-asset-root"), "assets"),
    mossTimeoutMs: 1_000,
    mossIdleShutdownMs: 0,
    mossFfmpegCommand: "ffmpeg"
  }, { fetch: fakeFetch as typeof fetch, spawn: fakeSpawn });

  await assert.rejects(
    synthesize({ text: "晚点见", time: createCurrentTimeProvider("UTC", () => new Date("2026-05-26T00:00:00.000Z")) }),
    /custom MOSS_TTS_BASE_URL disables local auto-start/
  );
  assert.equal(spawnCalls, 0);
});

test("configured voice synthesizer falls back to moss when genie model is missing", async () => {
  const calls: string[] = [];
  const fakeFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const pathname = new URL(String(url)).pathname;
    calls.push(`${init?.method ?? "GET"} ${pathname}`);
    if (pathname === "/health") return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (pathname === "/synthesize") {
      const body = JSON.parse(String(init?.body)) as { outputPath: string };
      fs.mkdirSync(path.dirname(body.outputPath), { recursive: true });
      fs.writeFileSync(body.outputPath, "wav");
      return new Response(JSON.stringify({ ok: true, audioPath: body.outputPath }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: false }), { status: 404 });
  };
  const synthesize = createConfiguredVoiceSynthesizer({
    backend: "genie-tts",
    genieModelDir: "assets/tts/genie/models/not-found",
    mossBaseURL: "http://127.0.0.1:9876",
    mossReferenceAudio: "test.opus",
    mossOutputDir: "generated/tts",
    assetRoot: path.join(makeTempDir("tts-asset-root"), "assets"),
    mossIdleShutdownMs: 0,
    mossFfmpegCommand: "ffmpeg"
  }, { fetch: fakeFetch as typeof fetch, spawn: fakeFfmpegSpawn() });

  const result = await synthesize({ text: "晚点见", time: createCurrentTimeProvider("UTC", () => new Date("2026-05-26T00:00:00.000Z")) });

  assert.match(result.assetId, /^generated\/tts\/20260526_000000_000\.opus$/);
  assert.deepEqual(calls, ["GET /health", "POST /synthesize"]);
  await fsp.unlink(result.filePath);
});

test("genie tts voice synthesizer calls service and returns opus asset", async () => {
  const fixture = makeTtsAssetFixture("tts-genie-call");
  const calls: string[] = [];
  const requestedTexts: string[] = [];
  const requestedOverrides: Array<Record<string, unknown>> = [];
  const ffmpegArgs: string[][] = [];
  const fakeFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const pathname = new URL(String(url)).pathname;
    calls.push(`${init?.method ?? "GET"} ${pathname}`);
    if (pathname === "/health") return new Response(JSON.stringify({ ok: true, ready: true }), { status: 200 });
    if (pathname === "/synthesize") {
      const body = JSON.parse(String(init?.body)) as { text: string; outputPath: string } & Record<string, unknown>;
      requestedTexts.push(body.text);
      requestedOverrides.push({
        language: body.language,
        modelDir: body.modelDir,
        referenceAudioPath: body.referenceAudioPath,
        referenceText: body.referenceText,
        partSilenceSeconds: body.partSilenceSeconds,
        splitText: body.splitText
      });
      fs.mkdirSync(path.dirname(body.outputPath), { recursive: true });
      fs.writeFileSync(body.outputPath, "wav");
      return new Response(JSON.stringify({ ok: true, audioPath: body.outputPath }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: false }), { status: 404 });
  };
  const ffmpegSpawn = fakeFfmpegSpawn();
  const spawn = ((command: string, args: readonly string[]) => {
    if (command === "ffmpeg") ffmpegArgs.push([...args]);
    return ffmpegSpawn(command, args);
  }) as any;
  const synthesize = createGenieTtsVoiceSynthesizer({
    backend: "genie-tts",
    genieBaseURL: "http://127.0.0.1:8767",
    genieOutputDir: "generated/tts",
    assetRoot: fixture.assetRoot,
    genieIdleShutdownMs: 0,
    genieFfmpegCommand: "ffmpeg"
  }, { fetch: fakeFetch as typeof fetch, spawn });

  try {
    const text = "啊……\n等等、、、可以吗？？";
    const result = await synthesize({
      text,
      time: createCurrentTimeProvider("UTC", () => new Date("2026-05-26T00:00:00.000Z")),
      genie: {
        language: "jp",
        modelDir: fixture.modelDir,
        referenceAudio: fixture.referenceAudio,
        referenceText: "参照テキスト",
        speed: 1.25,
        partSilenceSeconds: 0.4,
        splitText: false
      }
    });

    assert.match(result.assetId, /^generated\/tts\/20260526_000000_000\.opus$/);
    assert.equal(fs.readFileSync(result.filePath, "utf8"), "opus");
    assert.deepEqual(calls, ["GET /health", "POST /synthesize"]);
    assert.deepEqual(requestedTexts, [text]);
    assert.deepEqual(requestedOverrides, [{
      language: "jp",
      modelDir: path.resolve("assets", fixture.modelDir),
      referenceAudioPath: path.resolve("assets", fixture.referenceAudio),
      referenceText: "参照テキスト",
      partSilenceSeconds: 0.4,
      splitText: false
    }]);
    assert.ok(ffmpegArgs.some((args) => args.includes("-filter:a") && args.includes("atempo=1.25")));
    await fsp.unlink(result.filePath);
  } finally {
    fixture.cleanup();
  }
});

test("genie tts recovers generated file when synthesize response times out", async () => {
  const calls: string[] = [];
  const fakeFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const pathname = new URL(String(url)).pathname;
    calls.push(`${init?.method ?? "GET"} ${pathname}`);
    if (pathname === "/health") return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (pathname === "/synthesize") {
      const body = JSON.parse(String(init?.body)) as { outputPath: string };
      fs.mkdirSync(path.dirname(body.outputPath), { recursive: true });
      fs.writeFileSync(body.outputPath, "wav");
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      throw error;
    }
    return new Response(JSON.stringify({ ok: false }), { status: 404 });
  };
  const synthesize = createGenieTtsVoiceSynthesizer({
    backend: "genie-tts",
    genieBaseURL: "http://127.0.0.1:8767",
    genieOutputDir: "generated/tts",
    assetRoot: path.join(makeTempDir("tts-asset-root"), "assets"),
    genieTimeoutMs: 5,
    genieIdleShutdownMs: 0,
    genieFfmpegCommand: "ffmpeg"
  }, { fetch: fakeFetch as typeof fetch, spawn: fakeFfmpegSpawn() });

  const result = await synthesize({
    text: "また後で",
    time: createCurrentTimeProvider("UTC", () => new Date("2026-05-26T00:00:00.000Z"))
  });

  assert.deepEqual(calls, ["GET /health", "POST /synthesize"]);
  assert.match(result.assetId, /^generated\/tts\/20260526_000000_000\.opus$/);
  assert.equal(fs.readFileSync(result.filePath, "utf8"), "opus");
  await fsp.unlink(result.filePath);
});

test("genie tts exposes streaming PCM chunks through streamAudio", async () => {
  const calls: string[] = [];
  const requestBodies: unknown[] = [];
  const fakeFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const pathname = new URL(String(url)).pathname;
    calls.push(`${init?.method ?? "GET"} ${pathname}`);
    if (pathname === "/health") return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (pathname === "/stream") {
      requestBodies.push(JSON.parse(String(init?.body)));
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2]));
          controller.enqueue(new Uint8Array([3, 4]));
          controller.close();
        }
      }), { status: 200, headers: { "content-type": "audio/L16; rate=32000; channels=1" } });
    }
    return new Response(JSON.stringify({ ok: false }), { status: 404 });
  };
  const synthesize = createGenieTtsVoiceSynthesizer({
    backend: "genie-tts",
    genieBaseURL: "http://127.0.0.1:8767",
    genieOutputDir: "generated/tts",
    assetRoot: path.join(makeTempDir("tts-asset-root"), "assets"),
    genieIdleShutdownMs: 0
  }, { fetch: fakeFetch as typeof fetch, spawn: fakeFfmpegSpawn() });

  const chunks = [];
  for await (const chunk of synthesize.streamAudio!({
    text: "また後で",
    time: createCurrentTimeProvider("UTC"),
    genie: {
      language: "jp",
      splitText: true
    }
  })) {
    chunks.push(Array.from(chunk));
  }

  assert.deepEqual(calls, ["GET /health", "POST /stream"]);
  assert.deepEqual(requestBodies, [{ text: "また後で", language: "jp", splitText: true }]);
  assert.deepEqual(chunks, [[1, 2], [3, 4]]);
});

test("genie tts can synthesize an opus asset from remote stream audio", async () => {
  const calls: string[] = [];
  const requestBodies: Array<Record<string, unknown>> = [];
  const ffmpegArgs: string[][] = [];
  const fakeFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const pathname = new URL(String(url)).pathname;
    calls.push(`${init?.method ?? "GET"} ${pathname}`);
    if (pathname === "/health") return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (pathname === "/stream") {
      requestBodies.push(JSON.parse(String(init?.body)));
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([0xff, 0x3f, 0x00, 0x40]));
          controller.close();
        }
      }), { status: 200, headers: { "content-type": "audio/L16; rate=32000; channels=1" } });
    }
    return new Response(JSON.stringify({ ok: false }), { status: 404 });
  };
  const ffmpegSpawn = fakeFfmpegSpawn();
  const spawn = ((command: string, args: readonly string[]) => {
    if (command === "ffmpeg") ffmpegArgs.push([...args]);
    return ffmpegSpawn(command, args);
  }) as any;
  const synthesize = createGenieTtsVoiceSynthesizer({
    backend: "genie-tts",
    genieBaseURL: "http://127.0.0.1:8767",
    genieOutputDir: "generated/tts",
    assetRoot: path.join(makeTempDir("tts-asset-root"), "assets"),
    genieIdleShutdownMs: 0,
    genieFfmpegCommand: "ffmpeg",
    genieUseStreamForSynthesis: true
  }, { fetch: fakeFetch as typeof fetch, spawn });

  const result = await synthesize({
    text: "また後で",
    time: createCurrentTimeProvider("UTC", () => new Date("2026-05-26T00:00:00.000Z")),
    genie: {
      language: "jp",
      speed: 1.15,
      splitText: true
    }
  });

  assert.deepEqual(calls, ["GET /health", "POST /stream"]);
  assert.deepEqual(requestBodies, [{ text: "また後で", language: "jp", splitText: true }]);
  assert.match(result.assetId, /^generated\/tts\/20260526_000000_000\.opus$/);
  assert.equal(fs.readFileSync(result.filePath, "utf8"), "opus");
  assert.ok(ffmpegArgs.some((args) => args.includes("-filter:a") && args.includes("atempo=1.15")));
  await fsp.unlink(result.filePath);
});

test("genie remote stream uploads missing model and retries original stream-input request", async () => {
  const fixture = makeTtsAssetFixture("tts-genie-remote-upload");
  fs.writeFileSync(path.join(fixture.root, "reference.txt"), "参照テキスト\n");
  const calls: string[] = [];
  const streamQueries: Array<Record<string, string>> = [];
  const streamBodies: string[] = [];
  const uploadBodies: Uint8Array[] = [];
  let streamAttempts = 0;
  const fakeFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const parsed = new URL(String(url));
    calls.push(`${init?.method ?? "GET"} ${parsed.pathname}`);
    if (parsed.pathname === "/health") return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (parsed.pathname === "/stream-input") {
      streamAttempts += 1;
      streamQueries.push(Object.fromEntries(parsed.searchParams.entries()));
      streamBodies.push(String(init?.body));
      if (streamAttempts === 1) {
        return new Response(JSON.stringify({
          ok: false,
          code: "MODEL_NOT_UPLOADED",
          modelDir: path.resolve("assets", fixture.modelDir),
          uploadUrl: `/models/upload?modelDir=${encodeURIComponent(path.resolve("assets", fixture.modelDir))}`
        }), { status: 409, headers: { "content-type": "application/json" } });
      }
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([7, 8]));
          controller.close();
        }
      }), { status: 200, headers: { "content-type": "audio/L16; rate=32000; channels=1" } });
    }
    if (parsed.pathname === "/models/upload") {
      assert.equal(init?.headers && (init.headers as Record<string, string>)["content-type"], "application/zip");
      uploadBodies.push(init?.body as Uint8Array);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: false }), { status: 404 });
  };
  const synthesize = createGenieTtsVoiceSynthesizer({
    backend: "genie-tts",
    genieBaseURL: "http://127.0.0.1:8767",
    genieBaseURLExplicit: true,
    genieOutputDir: "generated/tts",
    assetRoot: fixture.assetRoot,
    genieIdleShutdownMs: 0
  }, { fetch: fakeFetch as typeof fetch, spawn: fakeFfmpegSpawn() });

  try {
    const chunks = [];
    for await (const chunk of synthesize.streamAudio!({
      text: "第一段。",
      time: createCurrentTimeProvider("UTC"),
      genie: {
        language: "zh",
        modelDir: fixture.modelDir,
        referenceText: "参照テキスト"
      }
    })) {
      chunks.push(Array.from(chunk));
    }

    assert.deepEqual(calls, ["GET /health", "POST /stream-input", "POST /models/upload", "POST /stream-input"]);
    assert.equal(streamQueries.length, 2);
    assert.equal(streamQueries[0].language, "zh");
    assert.equal(streamQueries[0].modelDir, path.resolve("assets", fixture.modelDir));
    assert.equal(streamQueries[0].responseFormat, "ndjson");
    assert.deepEqual(streamQueries[1], streamQueries[0]);
    assert.deepEqual(streamBodies, [
      `${JSON.stringify({ text: "第一段。", referenceText: "参照テキスト" })}\n`,
      `${JSON.stringify({ text: "第一段。", referenceText: "参照テキスト" })}\n`
    ]);
    assert.equal(uploadBodies.length, 1);
    assert.deepEqual(Array.from(uploadBodies[0].slice(0, 4)), [0x50, 0x4b, 0x03, 0x04]);
    const zipText = new TextDecoder().decode(uploadBodies[0]);
    assert.equal(zipText.includes("model/t2s_encoder_fp32.onnx"), true);
    assert.equal(zipText.includes("reference.wav"), true);
    assert.equal(zipText.includes("reference.txt"), true);
    assert.deepEqual(chunks, [[7, 8]]);
  } finally {
    fixture.cleanup();
  }
});

test("genie remote text stream decodes ndjson audio text chunks", async () => {
  const fixture = makeTtsAssetFixture("tts-genie-remote-ndjson");
  fs.writeFileSync(path.join(fixture.root, "reference.txt"), "参照テキスト\n");
  const streamQueries: Array<Record<string, string>> = [];
  const fakeFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/health") return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (parsed.pathname === "/stream-input") {
      streamQueries.push(Object.fromEntries(parsed.searchParams.entries()));
      const body = [
        JSON.stringify({
          type: "audio",
          text: "これは一文目です。",
          format: "s16le",
          sampleRate: 32000,
          channels: 1,
          audioBase64: "AQI="
        }),
        JSON.stringify({
          type: "audio",
          text: "二文目です。",
          format: "s16le",
          sampleRate: 32000,
          channels: 1,
          audioBase64: "AwQ="
        }),
        JSON.stringify({ type: "done" })
      ].join("\n") + "\n";
      return new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson" } });
    }
    throw new Error("unexpected request");
  };
  const synthesize = createGenieTtsVoiceSynthesizer({
    backend: "genie-tts",
    genieBaseURL: "http://127.0.0.1:8767",
    genieBaseURLExplicit: true,
    genieOutputDir: "generated/tts",
    assetRoot: fixture.assetRoot,
    genieIdleShutdownMs: 0
  }, { fetch: fakeFetch as typeof fetch, spawn: fakeFfmpegSpawn() });

  try {
    const chunks = [];
    for await (const chunk of synthesize.streamAudioWithText!({
      text: "これは一文目です。二文目です。",
      time: createCurrentTimeProvider("UTC"),
      genie: {
        language: "jp",
        modelDir: fixture.modelDir,
        referenceText: "参照テキスト"
      }
    })) {
      chunks.push([chunk.text, Array.from(chunk.chunk)]);
    }

    assert.equal(streamQueries[0].responseFormat, "ndjson");
    assert.deepEqual(chunks, [
      ["これは一文目です。", [1, 2]],
      ["二文目です。", [3, 4]]
    ]);
  } finally {
    fixture.cleanup();
  }
});

test("genie remote stream uploads missing reference files and retries original stream-input request", async () => {
  const fixture = makeTtsAssetFixture("tts-genie-remote-reference-missing");
  fs.writeFileSync(path.join(fixture.root, "reference.txt"), "参照テキスト\n");
  const calls: string[] = [];
  const streamQueries: Array<Record<string, string>> = [];
  const uploadBodies: Uint8Array[] = [];
  let streamAttempts = 0;
  const fakeFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const parsed = new URL(String(url));
    calls.push(`${init?.method ?? "GET"} ${parsed.pathname}`);
    if (parsed.pathname === "/health") return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (parsed.pathname === "/stream-input") {
      streamAttempts += 1;
      streamQueries.push(Object.fromEntries(parsed.searchParams.entries()));
      if (streamAttempts === 1) {
        return new Response(JSON.stringify({
          ok: false,
          code: "REFERENCE_NOT_UPLOADED",
          error: "reference files are missing"
        }), { status: 409, headers: { "content-type": "application/json" } });
      }
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([9, 10]));
          controller.close();
        }
      }), { status: 200, headers: { "content-type": "audio/L16; rate=32000; channels=1" } });
    }
    if (parsed.pathname === "/models/upload") {
      assert.equal(parsed.searchParams.get("modelDir"), path.resolve("assets", fixture.modelDir));
      assert.equal(init?.headers && (init.headers as Record<string, string>)["content-type"], "application/zip");
      uploadBodies.push(init?.body as Uint8Array);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    throw new Error("unexpected request");
  };
  const synthesize = createGenieTtsVoiceSynthesizer({
    backend: "genie-tts",
    genieBaseURL: "http://127.0.0.1:8767",
    genieBaseURLExplicit: true,
    genieOutputDir: "generated/tts",
    assetRoot: fixture.assetRoot,
    genieIdleShutdownMs: 0
  }, { fetch: fakeFetch as typeof fetch, spawn: fakeFfmpegSpawn() });

  try {
    const chunks = [];
    for await (const chunk of synthesize.streamAudio!({
      text: "第一段。",
      time: createCurrentTimeProvider("UTC"),
      genie: {
        language: "zh",
        modelDir: fixture.modelDir
      }
    })) {
      chunks.push(Array.from(chunk));
    }
    assert.deepEqual(calls, ["GET /health", "POST /stream-input", "POST /models/upload", "POST /stream-input"]);
    assert.equal(streamQueries.length, 2);
    assert.equal(streamQueries[0].modelDir, path.resolve("assets", fixture.modelDir));
    assert.equal(streamQueries[0].responseFormat, "ndjson");
    assert.deepEqual(streamQueries[1], streamQueries[0]);
    assert.equal(uploadBodies.length, 1);
    const zipText = new TextDecoder().decode(uploadBodies[0]);
    assert.equal(zipText.includes("model/t2s_encoder_fp32.onnx"), true);
    assert.equal(zipText.includes("reference.wav"), true);
    assert.equal(zipText.includes("reference.txt"), true);
    assert.deepEqual(chunks, [[9, 10]]);
  } finally {
    fixture.cleanup();
  }
});

test("fallback voice synthesizer uses local synthesis when remote synthesis fails", async () => {
  const logs: string[] = [];
  const calls: string[] = [];
  const remote = Object.assign(async () => {
    calls.push("remote");
    throw new Error("remote offline");
  }, {}) as any;
  const local = Object.assign(async () => {
    calls.push("local");
    return { assetId: "generated/tts/local.opus", filePath: path.join(makeTempDir("fallback-local-tts"), "assets", "generated", "tts", "local.opus") };
  }, {}) as any;
  const synthesize = createFallbackVoiceSynthesizer(remote, local, {
    appendLog: (_level, message) => logs.push(message)
  });

  const result = await synthesize({ text: "また後で", time: createCurrentTimeProvider("UTC") });

  assert.deepEqual(calls, ["remote", "local"]);
  assert.equal(result.assetId, "generated/tts/local.opus");
  assert.equal(logs.some((message) => message.includes("falling back to local Genie")), true);
});

test("fallback voice synthesizer streams from local when remote stream fails before audio", async () => {
  const calls: string[] = [];
  const remote = Object.assign(async () => {
    throw new Error("not used");
  }, {
    async *streamAudio() {
      calls.push("remote");
      throw new Error("remote stream offline");
    }
  }) as any;
  const local = Object.assign(async () => {
    throw new Error("not used");
  }, {
    async *streamAudio() {
      calls.push("local");
      yield new Uint8Array([9, 1]);
    }
  }) as any;
  const synthesize = createFallbackVoiceSynthesizer(remote, local);

  const chunks = [];
  for await (const chunk of synthesize.streamAudio!({ text: "また後で", time: createCurrentTimeProvider("UTC") })) {
    chunks.push(Array.from(chunk));
  }

  assert.deepEqual(calls, ["remote", "local"]);
  assert.deepEqual(chunks, [[9, 1]]);
});

test("genie tts owned service shuts down on idle timeout", async () => {
  const fixture = makeTtsAssetFixture("tts-genie-idle");
  const calls: string[] = [];
  let healthCalls = 0;
  let idleCallback: (() => void) | undefined;
  const fakeFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const pathname = new URL(String(url)).pathname;
    calls.push(`${init?.method ?? "GET"} ${pathname}`);
    if (pathname === "/health") {
      healthCalls += 1;
      return new Response(JSON.stringify({ ok: healthCalls > 1 }), { status: healthCalls > 1 ? 200 : 503 });
    }
    if (pathname === "/shutdown") return new Response(JSON.stringify({ ok: true }), { status: 200 });
    return new Response(JSON.stringify({ ok: false }), { status: 404 });
  };
  const fakeSpawn = (() => {
    const child = new events.EventEmitter() as any;
    child.stdout = new events.EventEmitter();
    child.stderr = new events.EventEmitter();
    child.exitCode = null;
    child.kill = () => {
      child.emit("exit", null, "SIGTERM");
      return true;
    };
    return child;
  }) as any;
  const synthesize = createGenieTtsVoiceSynthesizer({
    backend: "genie-tts",
    genieDataDir: fixture.modelDir,
    genieModelDir: fixture.modelDir,
    genieReferenceAudio: fixture.referenceAudio,
    genieReferenceText: "selfie/references/selfie-prompt.txt",
    genieOutputDir: "generated/tts",
    assetRoot: fixture.assetRoot,
    genieTimeoutMs: 1_000,
    genieIdleShutdownMs: 10
  }, {
    fetch: fakeFetch as typeof fetch,
    spawn: fakeSpawn,
    setTimeout: ((callback: () => void) => {
      idleCallback = callback;
      return { unref() {} };
    }) as any,
    clearTimeout: (() => {}) as any
  });

  try {
    await synthesize.prepare?.();
    idleCallback?.();
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(calls, ["GET /health", "GET /health", "POST /shutdown"]);
  } finally {
    fixture.cleanup();
  }
});

test("genie tts local service receives reference text content instead of text path", async () => {
  const fixture = makeTtsAssetFixture("tts-genie-reference-text-content");
  const referenceTextPath = path.join(fixture.root, "reference.txt");
  fs.writeFileSync(referenceTextPath, "明示的な参照テキスト\n");
  const calls: string[] = [];
  let healthCalls = 0;
  let spawnArgs: readonly string[] = [];
  const fakeFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const pathname = new URL(String(url)).pathname;
    calls.push(`${init?.method ?? "GET"} ${pathname}`);
    if (pathname === "/health") {
      healthCalls += 1;
      return new Response(JSON.stringify({ ok: healthCalls > 1 }), { status: healthCalls > 1 ? 200 : 503 });
    }
    if (pathname === "/shutdown") return new Response(JSON.stringify({ ok: true }), { status: 200 });
    return new Response(JSON.stringify({ ok: false }), { status: 404 });
  };
  const fakeSpawn = ((_command: string, args: readonly string[]) => {
    spawnArgs = args;
    const child = new events.EventEmitter() as any;
    child.stdout = new events.EventEmitter();
    child.stderr = new events.EventEmitter();
    child.exitCode = null;
    child.kill = () => true;
    return child;
  }) as any;
  const synthesize = createGenieTtsVoiceSynthesizer({
    backend: "genie-tts",
    genieDataDir: fixture.modelDir,
    genieModelDir: fixture.modelDir,
    genieReferenceAudio: fixture.referenceAudio,
    genieReferenceText: referenceTextPath,
    genieOutputDir: "generated/tts",
    assetRoot: fixture.assetRoot,
    genieTimeoutMs: 1_000,
    genieIdleShutdownMs: 0
  }, {
    fetch: fakeFetch as typeof fetch,
    spawn: fakeSpawn
  });

  try {
    await synthesize.prepare?.();
    const referenceTextIndex = spawnArgs.indexOf("--reference-text");
    assert.notEqual(referenceTextIndex, -1);
    assert.equal(spawnArgs[referenceTextIndex + 1], "明示的な参照テキスト");
    assert.deepEqual(calls, ["GET /health", "GET /health"]);
  } finally {
    await synthesize.shutdown?.();
    fixture.cleanup();
  }
});

test("configured voice synthesizer falls back to moss when explicit genie service is unhealthy", async () => {
  let spawnCalls = 0;
  const calls: string[] = [];
  const fakeFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const parsed = new URL(String(url));
    calls.push(`${parsed.port} ${init?.method ?? "GET"} ${parsed.pathname}`);
    if (parsed.port === "8767") return new Response(JSON.stringify({ ok: false }), { status: 503 });
    if (parsed.pathname === "/health") return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (parsed.pathname === "/synthesize") {
      const body = JSON.parse(String(init?.body)) as { outputPath: string };
      fs.mkdirSync(path.dirname(body.outputPath), { recursive: true });
      fs.writeFileSync(body.outputPath, "wav");
      return new Response(JSON.stringify({ ok: true, audioPath: body.outputPath }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: false }), { status: 404 });
  };
  const spawn = ((command: string, args: readonly string[]) => {
    if (command !== "ffmpeg") spawnCalls += 1;
    return fakeFfmpegSpawn()(command, args);
  }) as any;
  const synthesize = createConfiguredVoiceSynthesizer({
    backend: "genie-tts",
    genieBaseURL: "http://127.0.0.1:8767",
    genieBaseURLExplicit: true,
    mossBaseURL: "http://127.0.0.1:9876",
    mossReferenceAudio: "test.opus",
    mossOutputDir: "generated/tts",
    assetRoot: path.join(makeTempDir("tts-asset-root"), "assets"),
    mossIdleShutdownMs: 0,
    mossFfmpegCommand: "ffmpeg"
  }, { fetch: fakeFetch as typeof fetch, spawn });

  const time = createCurrentTimeProvider("UTC", () => new Date("2026-05-26T00:00:00.000Z"));
  const result = await synthesize({ text: "晚点见", time });
  const secondResult = await synthesize({ text: "再试一次", time });

  assert.match(result.assetId, /^generated\/tts\/20260526_000000_000\.opus$/);
  assert.match(secondResult.assetId, /^generated\/tts\/20260526_000000_000_2\.opus$/);
  assert.equal(spawnCalls, 0);
  assert.deepEqual(calls, [
    "8767 GET /health",
    "9876 GET /health",
    "9876 POST /synthesize",
    "9876 GET /health",
    "9876 POST /synthesize"
  ]);
  await fsp.unlink(result.filePath);
  await fsp.unlink(secondResult.filePath);
});

test("send_chat voice splits newline and escaped newline text into multiple audio messages", async () => {
  const dir = makeTempDir("messaging-send-voice-newline");
  const store = createAliceStore(path.join(dir, "alice.sqlite"));
  const sent: AgentOutput[] = [];
  const logs: Array<{ status?: string; summary: string }> = [];
  const synthesizedTexts: string[] = [];
  const tools = createMessagingTools({
    store,
    sleep: async () => {},
    voiceSynthesizer: async ({ text }) => {
      synthesizedTexts.push(text);
      const filePath = path.join(dir, "voice.wav");
      fs.writeFileSync(filePath, text);
      return { assetId: "generated/tts/voice.wav", filePath };
    },
    outputRouter: {
      async send(output) {
        sent.push(output);
        return { messageId: `voice_${sent.length}` };
      }
    },
    appendMessageLog(input) {
      logs.push({ status: input.status, summary: input.summary });
    },
    getDefaultTarget: () => ({ plugin: "wechat", userId: "wx-user", sessionId: "wechat:dm:wx-user" })
  });

  const result = await tools.execute({
    id: "call_send_voice_newline",
    toolName: "send_chat",
    input: { type: "voice", content: "第一句\n第二句\\n第三句" }
  });

  assert.equal(result.ok, true);
  assert.equal(sent.length, 3);
  assert.deepEqual(synthesizedTexts, ["第一句", "第二句", "第三句"]);
  assert.deepEqual(sent.map((output) => output.content.kind === "audio" ? output.content.transcript : ""), ["第一句", "第二句", "第三句"]);
  assert.deepEqual(logs, [
    { status: "sent", summary: "[语音]第一句" },
    { status: "sent", summary: "[语音]第二句" },
    { status: "sent", summary: "[语音]第三句" }
  ]);
});

test("send_chat voice returns tts failure without sending fallback text", async () => {
  const store = createAliceStore(path.join(makeTempDir("messaging-send-voice-tts-failed"), "alice.sqlite"));
  const logs: Array<{ status?: string; error?: string; summary: string }> = [];
  let sendCalls = 0;
  const tools = createMessagingTools({
    store,
    sleep: async () => {},
    voiceSynthesizer: async () => {
      throw new Error("tts unavailable");
    },
    outputRouter: {
      async send() {
        sendCalls += 1;
        return { messageId: "should-not-send" };
      }
    },
    getDefaultTarget: () => ({ plugin: "wechat", userId: "wx-user", sessionId: "wechat:dm:wx-user" }),
    appendMessageLog(input) {
      logs.push({ status: input.status, error: input.error, summary: input.summary });
    }
  });

  const result = await tools.execute({
    id: "call_send_voice_failed",
    toolName: "send_chat",
    input: { type: "voice", content: "不要发文字" }
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "tts unavailable");
  assert.equal(sendCalls, 0);
  assert.equal(logs[0].status, "tts_failed");
  assert.equal(logs[0].summary, "不要发文字");
  assert.equal(store.listMessagesForConversation("wechat:dm:wx-user", 10).filter((message) => message.direction === "outbound").length, 0);
});

test("send_chat voice send failure marks failed and removes generated file without retry", async () => {
  const dir = makeTempDir("messaging-send-voice-send-failed");
  const store = createAliceStore(path.join(dir, "alice.sqlite"));
  const logs: Array<{ status?: string; error?: string; summary: string }> = [];
  let attempts = 0;
  let generatedPath = "";
  const trainingDir = path.join(dir, "tts-training", "voice-massage");
  const tools = createMessagingTools({
    store,
    sleep: async () => {},
    voiceMessageTtsTrainingOutputDir: trainingDir,
    voiceSynthesizer: async () => {
      generatedPath = path.join(dir, "voice.wav");
      fs.writeFileSync(generatedPath, "voice");
      return { assetId: "generated/tts/voice.wav", filePath: generatedPath };
    },
    outputRouter: {
      async send() {
        attempts += 1;
        throw new Error("wechat audio failed");
      }
    },
    getDefaultTarget: () => ({ plugin: "wechat", userId: "wx-user", sessionId: "wechat:dm:wx-user" }),
    appendMessageLog(input) {
      logs.push({ status: input.status, error: input.error, summary: input.summary });
    }
  });

  const result = await tools.execute({
    id: "call_send_voice_send_failed",
    toolName: "send_chat",
    input: { type: "voice", content: "语音内容" }
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(result.ok, false);
  assert.equal(result.error, "wechat audio failed");
  assert.equal(attempts, 1);
  assert.equal(fs.existsSync(generatedPath), false);
  const trainingFiles = fs.readdirSync(trainingDir).sort();
  const audioFileName = trainingFiles.find((fileName) => fileName.endsWith(".wav"));
  assert.ok(audioFileName);
  const audioFilePath = path.join(trainingDir, audioFileName);
  assert.equal(fs.readFileSync(audioFilePath, "utf8"), "voice");
  assert.equal(JSON.parse(fs.readFileSync(`${audioFilePath}.json`, "utf8")).status, "failed");
  assert.equal(logs.filter((entry) => entry.status === "send_failed").length, 1);
  assert.equal(logs.some((entry) => entry.status === "retry_failed"), false);
  const stored = store.listMessagesForConversation("wechat:dm:wx-user", 10).filter((message) => message.direction === "outbound");
  assert.equal(stored.length, 1);
  assert.equal(stored[0].contentType, "audio");
  assert.equal(stored[0].status, "send_failed");
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
  const dir = path.join(process.cwd(), ".tmp-tests", `alice-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeTtsAssetFixture(prefix: string): { root: string; assetRoot: string; modelDir: string; referenceAudio: string; cleanup(): void } {
  const assetRoot = path.join(makeTempDir(`${prefix}-asset-root`), "assets");
  const root = path.join(assetRoot, "generated", `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const modelDir = path.join(root, "model");
  const referenceAudio = path.join(root, "reference.wav");
  fs.mkdirSync(modelDir, { recursive: true });
  for (const fileName of genieRequiredModelFiles) {
    fs.writeFileSync(path.join(modelDir, fileName), "model");
  }
  fs.writeFileSync(referenceAudio, "wav");
  return {
    root,
    assetRoot,
    modelDir,
    referenceAudio,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

function fakeFfmpegSpawn(): any {
  return ((command: string, args: readonly string[]) => {
    const child = new events.EventEmitter() as any;
    child.stdout = new events.EventEmitter();
    child.stderr = new events.EventEmitter();
    child.exitCode = null;
    process.nextTick(() => {
      if (command === "ffmpeg") {
        if (args.includes("-f") && args.includes("s16le") && String(args[args.length - 1]) === "-") {
          const pcm = new Uint8Array(2000);
          for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
            pcm[offset] = 0xff;
            pcm[offset + 1] = 0x3f;
          }
          child.stdout.emit("data", pcm);
        } else {
          fs.writeFileSync(String(args[args.length - 1]), "opus");
        }
      }
      child.emit("exit", 0, null);
    });
    return child;
  }) as any;
}
