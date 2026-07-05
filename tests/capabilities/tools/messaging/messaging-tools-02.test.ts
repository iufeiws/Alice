import { test } from "node:test";
import assert from "node:assert/strict";
import { createCurrentTimeProvider } from "../../../../src/platform/time/src/index.js";
import { formatToolResultForLLM } from "../../../../src/contexts/agent-profile/src/application/llm-text-renderer.js";
import { createMessagingTools } from "../../../../src/capabilities/tools/messaging/src/index.js";
import { createFinishAndWaitTools } from "../../../../src/capabilities/tools/finish-and-wait/src/index.js";
import { collectTtsStreamText, createBailianTtsVoiceSynthesizer, createConfiguredVoiceSynthesizer, createFallbackVoiceSynthesizer, createGenieTtsVoiceSynthesizer, createMimoTtsVoiceSynthesizer, createMossOnnxVoiceSynthesizer, createOpenAiApiTtsVoiceSynthesizer, createTtsPcmProgressTextMapper, createTtsPlugin, createTtsRemoteAwareVoiceSynthesizer, createTtsTranslationSynthesizer, resolveTtsText, splitTtsStreamParts, splitTtsTextChunks, synthesizeTtsRouted, ttsGenieOverrides, readTtsPluginConfig, type VoiceSynthesizer } from "../../../../src/channels/tts/src/index.js";
import { createAliceStore } from "../../../../src/contexts/conversation-hub/src/adapters/sqlite-conversation-store.js";
import type { AgentOutput } from "../../../../src/contexts/agent-loop/src/contracts/agent-contracts.js";

const fs = await import("node:fs");
const fsp = await import("node:fs/promises");
const path = await import("node:path");
const os = await import("node:os");
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

test("check_chat default poll returns the first unread message", async () => {
  const store = createAliceStore(path.join(makeTempDir("messaging-default-first"), "alice.sqlite"));
  store.upsertInboundMessage({
    plugin: "feishu",
    externalMessageId: "om_1",
    conversationId: "session-1",
    senderId: "user-1",
    contentType: "text",
    contentText: "initial today",
    createdAt: "2026-05-26T01:00:00.000Z"
  });
  const tools = createDefaultChatTools(store);

  const first = await tools.execute({ id: "call_1", toolName: "Chat", input: { action: "poll" } });
  assert.equal(first.ok, true);
  assert.match(String(first.output), /initial today/);
});

test("check_chat default poll returns new messages across sessions", async () => {
  const store = createAliceStore(path.join(makeTempDir("messaging-default-cross-session"), "alice.sqlite"));
  store.upsertInboundMessage({
    plugin: "feishu",
    externalMessageId: "om_1",
    conversationId: "session-1",
    senderId: "user-1",
    contentType: "text",
    contentText: "initial today",
    createdAt: "2026-05-26T01:00:00.000Z"
  });
  const tools = createDefaultChatTools(store);
  await tools.execute({ id: "call_1", toolName: "Chat", input: { action: "poll" } });

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

  const second = await tools.execute({ id: "call_2", toolName: "Chat", input: { action: "poll" } });
  assert.equal(second.ok, true);
  assert.match(String(second.output), /after first default check/);
  assert.match(String(second.output), /wechat after first check/);
});

test("check_chat default poll returns empty output when no messages are pending", async () => {
  const store = createAliceStore(path.join(makeTempDir("messaging-default-empty"), "alice.sqlite"));
  const tools = createDefaultChatTools(store);

  const result = await tools.execute({ id: "call_empty", toolName: "Chat", input: { action: "poll" } });
  assert.equal(result.ok, true);
  assert.match(String(result.output), /^<chat-log>\nnothing new\n<\/chat-log>\n<now local="\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}"\/>$/);
});

test("check_chat default poll advances the repeated-call cursor", async () => {
  const store = createAliceStore(path.join(makeTempDir("messaging-default-cursor"), "alice.sqlite"));
  store.upsertInboundMessage({
    plugin: "feishu",
    externalMessageId: "om_1",
    conversationId: "session-1",
    senderId: "user-1",
    contentType: "text",
    contentText: "consume once",
    createdAt: "2026-05-26T01:00:00.000Z"
  });
  const tools = createDefaultChatTools(store);
  await tools.execute({ id: "call_first", toolName: "Chat", input: { action: "poll" } });

  const repeated = await tools.execute({ id: "call_repeated", toolName: "Chat", input: { action: "poll" } });
  assert.equal(repeated.ok, true);
  assert.doesNotMatch(String(repeated.output), /consume once/);
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

  const result = await tools.execute({ id: "call_system_prompt", toolName: "Chat", input: { action: "poll",  scope: "today" } });
  assert.equal(result.ok, true);
  assert.match(String(result.output), /\n-少女拍照中-\n/);
  assert.doesNotMatch(String(result.output), /-少女拍照中-\[发送中\]/);
  assert.doesNotMatch(String(result.output), /\(大失败\.\.\.\)\[发送中\]/);
  assert.match(String(result.output), /\n\(大失败\.\.\.\)/);
  assert.doesNotMatch(String(result.output), /system:/);
  assert.doesNotMatch(String(result.output), /Alice:-少女拍照中-/);
  assert.doesNotMatch(String(result.output), /Alice:\(大失败\.\.\.\)/);
});

test("check_chat simplifies outbound image records", async () => {
  const store = createAliceStore(path.join(makeTempDir("messaging-image-record"), "alice.sqlite"));
  store.insertOutboundMessage({
    plugin: "feishu",
    conversationId: "session-1",
    contentType: "image",
    contentText: "generated/selfies/selfie_20260528_160956.jpg",
    contentJson: JSON.stringify({ kind: "image", assetId: "generated/selfies/selfie_20260528_160956.jpg" }),
    createdAt: "2026-05-26T12:00:00.000Z"
  });
  const tools = createDefaultChatTools(store);

  const result = await tools.execute({ id: "call_image_record", toolName: "Chat", input: { action: "poll",  scope: "today" } });
  assert.equal(result.ok, true);
  assert.match(String(result.output), /Alice发送了一张图片/);
  assert.doesNotMatch(String(result.output), /selfie_20260528_160956\.jpg/);
});

test("check_chat simplifies outbound audio records", async () => {
  const store = createAliceStore(path.join(makeTempDir("messaging-audio-record"), "alice.sqlite"));
  store.insertOutboundMessage({
    plugin: "feishu",
    conversationId: "session-1",
    contentType: "audio",
    contentText: "[语音][0:0.020,0:5.000]  晚点见",
    contentJson: JSON.stringify({ kind: "audio", assetId: "voice-1.mp3", transcript: "[语音][0:0.020,0:5.000]  晚点见" }),
    createdAt: "2026-05-26T12:00:01.000Z"
  });
  const tools = createDefaultChatTools(store);

  const result = await tools.execute({ id: "call_audio_record", toolName: "Chat", input: { action: "poll",  scope: "today" } });
  assert.equal(result.ok, true);
  assert.match(String(result.output), /Alice:\[语音\]晚点见/);
  assert.doesNotMatch(String(result.output), /0:0\.020|0:5\.000/);
});

test("check_chat simplifies outbound file records", async () => {
  const store = createAliceStore(path.join(makeTempDir("messaging-file-record"), "alice.sqlite"));
  store.insertOutboundMessage({
    plugin: "feishu",
    conversationId: "session-1",
    contentType: "file",
    contentText: "report.pdf",
    contentJson: JSON.stringify({ kind: "file", assetId: "files/report.pdf", filename: "report.pdf" }),
    createdAt: "2026-05-26T12:00:02.000Z"
  });
  const tools = createDefaultChatTools(store);

  const result = await tools.execute({ id: "call_file_record", toolName: "Chat", input: { action: "poll",  scope: "today" } });
  assert.equal(result.ok, true);
  assert.match(String(result.output), /Alice发送了文件\[report\.pdf\]/);
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

  const result = await tools.execute({ id: "call_voicecalltranscript", toolName: "Chat", input: { action: "poll",  scope: "today" } });
  assert.equal(result.ok, true);
  assert.match(String(result.output), /<chat-log>\n<voice-call-transcript>\n\[2026-06-07 00:00:00\]\n-已接通-/);
  assert.match(String(result.output), /\{\{user\}\}:\n喂，爱丽丝，能听到吗？\n我刚到车站，想确认一下今晚的安排。\nAlice:\n听得到。\n今晚先去吃饭，然后回去把明天要用的东西收好。/);
  assert.match(String(result.output), /\[message\]\{\{user\}\}:我刚才也发了一条飞书确认。\n\{\{user\}\}:\n好，那我二十分钟后到。你帮我记一下别忘了买水。/);
  assert.match(String(result.output), /Alice:\n记下了，路上慢点，到附近再给我发一条消息。\n\[message\]Alice:我在飞书里也提醒你买水了。\n-已挂断-\n<call-duration>0:20<\/call-duration>\n<\/voice-call-transcript>\n<\/chat-log>/);
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

  const recent = await tools.execute({ id: "call_recent", toolName: "Chat", input: { action: "poll",  scope: "recent" } });
  assert.equal(recent.ok, true);
  assert.doesNotMatch(String(recent.output), /msg 60\b/);
  assert.doesNotMatch(String(recent.output), /msg 510\b/);
  assert.match(String(recent.output), /msg 511\b/);
  assert.match(String(recent.output), /msg 560\b/);
  assert.equal((String(recent.output).match(/\{\{user\}\}:msg /g) ?? []).length, 50);
});

test("check_chat preview returns pending message content", async () => {
  const store = createAliceStore(path.join(makeTempDir("messaging-preview-output"), "alice.sqlite"));
  store.upsertInboundMessage({
    plugin: "feishu",
    externalMessageId: "om_1",
    conversationId: "session-1",
    senderId: "user-1",
    contentType: "text",
    contentText: "preview should not consume",
    createdAt: "2026-05-26T12:01:00.000"
  });
  const tools = createDefaultChatTools(store);

  const preview = await tools.execute({
    id: "call_preview",
    toolName: "Chat", input: { action: "poll",  __preview: true }
  });
  assert.equal(preview.ok, true);
  assert.match(String(preview.output), /preview should not consume/);
});

test("check_chat preview leaves message read state unchanged", async () => {
  const store = createAliceStore(path.join(makeTempDir("messaging-preview-read-state"), "alice.sqlite"));
  store.upsertInboundMessage({
    plugin: "feishu",
    externalMessageId: "om_1",
    conversationId: "session-1",
    senderId: "user-1",
    contentType: "text",
    contentText: "preview should not read",
    createdAt: "2026-05-26T12:01:00.000"
  });
  const tools = createDefaultChatTools(store);
  await tools.execute({ id: "call_preview", toolName: "Chat", input: { action: "poll",  __preview: true } });

  const stored = store.listMessagesForConversation("session-1", 10)[0];
  assert.equal(Boolean(stored.isRead), false);
  assert.equal(stored.readAt ?? undefined, undefined);
  assert.equal(stored.coreProcessedAt ?? undefined, undefined);
});

test("check_chat preview leaves the pending conversation cursor unchanged", async () => {
  const store = createAliceStore(path.join(makeTempDir("messaging-preview-pending"), "alice.sqlite"));
  store.upsertInboundMessage({
    plugin: "feishu",
    externalMessageId: "om_1",
    conversationId: "session-1",
    senderId: "user-1",
    contentType: "text",
    contentText: "preview should stay pending",
    createdAt: "2026-05-26T12:01:00.000"
  });
  const tools = createDefaultChatTools(store);
  await tools.execute({ id: "call_preview", toolName: "Chat", input: { action: "poll",  __preview: true } });

  assert.equal(store.listPendingCoreConversations()[0].conversationId, "session-1");
});

test("check_chat recent preview can show already consumed messages", async () => {
  const store = createAliceStore(path.join(makeTempDir("messaging-recent-preview"), "alice.sqlite"));
  store.upsertInboundMessage({
    plugin: "feishu",
    externalMessageId: "om_1",
    conversationId: "session-1",
    senderId: "user-1",
    contentType: "text",
    contentText: "recent preview can repeat",
    createdAt: "2026-05-26T12:01:00.000"
  });
  const tools = createDefaultChatTools(store);

  await tools.execute({ id: "call_first", toolName: "Chat", input: { action: "poll" } });
  const recentPreview = await tools.execute({
    id: "call_recent_preview",
    toolName: "Chat", input: { action: "poll",  __preview: true, __scope: "recent" }
  });
  assert.equal(recentPreview.ok, true);
  assert.match(String(recentPreview.output), /recent preview can repeat/);
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
  const beforeResult = await beforeSix.execute({ id: "call_before", toolName: "Chat", input: { action: "poll",  scope: "recent" } });
  assert.match(String(beforeResult.output), /prev evening/);
  assert.match(String(beforeResult.output), /today early/);

  const afterSix = createMessagingTools({
    store,
    time: createCurrentTimeProvider("Asia/Shanghai", () => new Date("2026-05-25T22:30:00.000Z")),
    outputRouter: { async send() {} },
    getDefaultTarget: () => ({ plugin: "feishu", sessionId: "session-1" })
  });
  const afterResult = await afterSix.execute({ id: "call_after", toolName: "Chat", input: { action: "poll",  scope: "recent" } });
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

  const result = await tools.execute({ id: "call_time_label", toolName: "Chat", input: { action: "poll" } });
  assert.match(String(result.output), /\[2026-05-25 23:30:00\]\n\{\{user\}\}:late yesterday/);
  assert.doesNotMatch(String(result.output), /\[(?:today|yesterday) /);
});

function createDefaultChatTools(store: ReturnType<typeof createAliceStore>) {
  return createMessagingTools({
    store,
    time: createCurrentTimeProvider("Asia/Shanghai", () => new Date("2026-05-26T12:02:00.000Z")),
    outputRouter: { async send() {} },
    getSleepCocoonEnteredAt: () => "2026-05-26T00:00:00.000",
    getDefaultTarget: () => ({ plugin: "feishu", sessionId: "session-1" })
  });
}

async function eventually(condition: () => boolean, timeoutMs = 500): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("condition was not met before timeout");
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function makeTempDir(name: string): string {
  const dir = path.join(os.tmpdir(), "alice-tests", `alice-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

let seedInboundCounter = 0;

function seedUserInbound(store: ReturnType<typeof createAliceStore>, conversationId: string, plugin: string): void {
  seedInboundCounter += 1;
  store.upsertInboundMessage({
    plugin,
    externalMessageId: `seed_user_inbound_${seedInboundCounter}`,
    conversationId,
    senderId: "user-1",
    senderRole: "user",
    contentType: "text",
    contentText: "user reply",
    createdAt: new Date(Date.parse("2026-05-25T00:00:00.000Z") + seedInboundCounter).toISOString()
  });
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
