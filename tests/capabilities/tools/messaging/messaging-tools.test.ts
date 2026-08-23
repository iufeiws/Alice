import { test } from "node:test";
import assert from "node:assert/strict";
import { createCurrentTimeProvider } from "../../../../src/platform/time/src/index.js";
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

test("messagingTools_listTools_exposesChatOnly", async () => {
  const store = createAliceStore(path.join(makeTempDir("messaging-tools"), "alice.sqlite"));
  const tools = createMessagingTools({
    store,
    outputRouter: { async send() {} },
    getDefaultTarget: () => ({ plugin: "feishu", sessionId: "session-1" })
  });

  const names = tools.listTools().map((tool) => tool.name);
  assert.equal(names.length, 1);
});

test("finishAndWaitTools_schedule_returnsYieldMeta", async () => {
  const tools = createFinishAndWaitTools();
  const waitTool = tools.listTools().find((tool) => tool.name === "Yield");
  assert.ok(waitTool);
  const result = await tools.execute({ id: "call_schedule", toolName: "Yield", input: { action: "schedule", timer: 60 } });
  assert.equal(result.ok, true);
  assert.equal(result.meta?.yieldReturn, true);
  assert.equal(result.meta?.yieldAction, "schedule");
  assert.equal(result.meta?.yieldSeconds, 60);
  assert.equal(result.output, undefined);
});

test("finishAndWaitTools validates actions and wait range", async () => {
  const tools = createFinishAndWaitTools();
  const waitTool = tools.listTools().find((tool) => tool.name === "Yield");
  assert.ok(waitTool);
  assert.equal(waitTool.description.includes("schedule"), false);
  const inputSchema = waitTool.inputSchema as {
    type: string;
    properties: { action: { type?: string; enum?: string[] } };
    required: string[];
    additionalProperties: boolean;
    oneOf?: unknown;
  };
  assert.equal(inputSchema.type, "object");
  assert.equal(inputSchema.properties.action.type, "string");
  assert.deepEqual(inputSchema.properties.action.enum, ["await_chat", "finish"]);
  assert.deepEqual(inputSchema.required, ["action"]);
  assert.equal(inputSchema.additionalProperties, false);
  assert.equal(inputSchema.oneOf, undefined);
  for (const timer of [10, 900]) {
    const result = await tools.execute({ id: `schedule_${timer}`, toolName: "Yield", input: { action: "schedule", timer } });
    assert.equal(result.ok, true);
    assert.equal(result.meta?.yieldSeconds, timer);
  }
  const awaitChat = await tools.execute({ id: "await_chat", toolName: "Yield", input: { action: "await_chat" } });
  assert.equal(awaitChat.ok, true);
  assert.equal(awaitChat.meta?.yieldAction, "await_chat");
  assert.equal(awaitChat.meta?.yieldSeconds, 900);
  for (const input of [
    {},
    { action: "poll" },
    { action: "wait_for", timer: 10 },
    { action: "finish", timer: 10 },
    { action: "await_chat", timer: 10 },
    { action: "schedule" },
    { action: "schedule", timer: 9 },
    { action: "schedule", timer: 901 },
    { action: "schedule", timer: 10.5 },
    { action: "schedule", timer: 10, extra: true }
  ]) {
    const result = await tools.execute({ id: "invalid", toolName: "Yield", input });
    assert.equal(result.ok, false, JSON.stringify(input));
  }
  const finish = await tools.execute({ id: "finish", toolName: "Yield", input: { action: "finish" } });
  assert.equal(finish.invalidateLLMSession, true);
  assert.equal(finish.llmSessionClearReason, "yield_end");
  assert.equal(tools.listTools()[0].description.includes("关闭"), false);
  assert.equal(tools.listTools()[0].description.includes("会话"), false);
});

test("finishAndWaitTools rejects consecutive schedule without running subagent", async () => {
  const idle = createFinishAndWaitTools({ agentState: { getSubAgentHoldCount: () => 0 } });
  const first = await idle.execute({ id: "first", toolName: "Yield", input: { action: "schedule", timer: 60 } });
  assert.equal(first.ok, true);
  const consecutive = await idle.execute(
    { id: "second", toolName: "Yield", input: { action: "schedule", timer: 60 } },
    { lastCompletedToolName: "Yield" }
  );
  assert.equal(consecutive.ok, false);
  assert.match(String(consecutive.error), /schedule_consecutive/);

  const running = createFinishAndWaitTools({ agentState: { getSubAgentHoldCount: () => 1 } });
  const held = await running.execute(
    { id: "held", toolName: "Yield", input: { action: "schedule", timer: 60 } },
    { lastCompletedToolName: "Yield" }
  );
  assert.equal(held.ok, true);

  const afterBash = await idle.execute(
    { id: "after_bash", toolName: "Yield", input: { action: "schedule", timer: 60 } },
    { lastCompletedToolName: "Bash" }
  );
  assert.equal(afterBash.ok, true);
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
    toolName: "Chat", input: { action: "poll",  scope: "range", from: "2026-05-24T01:00:00.000Z", to: "2026-05-24T02:00:00.000Z" }
  });
  assert.equal(result.ok, true);
});

async function pollDefaultUnreadMessages(name: string) {
  const store = createAliceStore(path.join(makeTempDir(name), "alice.sqlite"));
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
    conversationId: "other-session",
    senderId: "user-1",
    contentType: "text",
    contentText: "hello from other session",
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

  const recent = await tools.execute({ id: "call_1", toolName: "Chat", input: { action: "poll" } });

  return { baseTime, recent, store, tools };
}

test("check_chat defaults to unread new messages", async () => {
  const { recent } = await pollDefaultUnreadMessages("messaging-view");

  assert.equal(recent.ok, true);
});

test("check_chat marks default unread messages as read", async () => {
  const { store } = await pollDefaultUnreadMessages("messaging-view-read-state");
  const readMessages = store.listMessages(10).filter((message) => message.direction === "inbound");

  assert.equal(readMessages.length, 3);
  assert.deepEqual(readMessages.map((message) => Boolean(message.isRead)), [true, true, true]);
  assert.deepEqual(readMessages.map((message) => Boolean(message.readAt)), [true, true, true]);
  assert.deepEqual(readMessages.map((message) => Boolean(message.coreProcessedAt)), [true, true, true]);
  assert.deepEqual(store.listPendingCoreConversations(), []);
});

test("check_chat default poll advances to the next unread message", async () => {
  const { baseTime, store, tools } = await pollDefaultUnreadMessages("messaging-view-next-unread");

  store.upsertInboundMessage({
    plugin: "feishu",
    externalMessageId: "om_3",
    conversationId: "session-1",
    senderId: "user-1",
    contentType: "text",
    contentText: "after today check",
    createdAt: new Date(baseTime + 7 * 60 * 1000).toISOString()
  });

  const recentAgain = await tools.execute({ id: "call_2", toolName: "Chat", input: { action: "poll" } });
  assert.equal(recentAgain.ok, true);
});

test("check_chat formats multiline text messages with speaker on its own line", async () => {
  const store = createAliceStore(path.join(makeTempDir("messaging-multiline-format"), "alice.sqlite"));
  store.upsertInboundMessage({
    plugin: "feishu",
    externalMessageId: "om_multiline_user",
    conversationId: "session-1",
    senderId: "user-1",
    contentType: "text",
    contentText: "user first\nuser second",
    createdAt: "2026-05-26T12:00:00.000Z"
  });
  store.insertOutboundMessage({
    plugin: "feishu",
    conversationId: "session-1",
    contentType: "text",
    contentText: "alice first\nalice second",
    createdAt: "2026-05-26T12:00:01.000Z"
  });
  store.insertOutboundMessage({
    plugin: "feishu",
    conversationId: "session-1",
    contentType: "image",
    contentText: "generated/selfies/selfie.jpg",
    contentJson: JSON.stringify({ kind: "image", assetId: "generated/selfies/selfie.jpg" }),
    createdAt: "2026-05-26T12:00:02.000Z"
  });

  const tools = createMessagingTools({
    store,
    time: createCurrentTimeProvider("Asia/Shanghai", () => new Date("2026-05-26T12:01:00.000Z")),
    outputRouter: { async send() {} },
    getSleepCocoonEnteredAt: () => "2026-05-26T00:00:00.000",
    getDefaultTarget: () => ({ plugin: "feishu", sessionId: "session-1" })
  });

  const result = await tools.execute({ id: "call_multiline_format", toolName: "Chat", input: { action: "poll",  scope: "today" } });
  assert.equal(result.ok, true);
});

test("check_chat default scope ignores active main llm session generation", async () => {
  const store = createAliceStore(path.join(makeTempDir("messaging-main-session-generation"), "alice.sqlite"));
  const baseTime = Date.parse("2026-06-11T00:00:00.000Z");
  store.upsertInboundMessage({
    plugin: "feishu",
    externalMessageId: "om_1",
    conversationId: "session-1",
    senderId: "user-1",
    contentType: "text",
    contentText: "first generation history",
    createdAt: new Date(baseTime).toISOString()
  });
  const tools = createMessagingTools({
    store,
    outputRouter: { async send() {} },
    time: createCurrentTimeProvider("UTC", () => new Date(baseTime + 60_000)),
    getSleepCocoonEnteredAt: () => new Date(baseTime - 1_000).toISOString(),
    getDefaultTarget: () => ({ plugin: "feishu", sessionId: "session-1" })
  });

  const first = await tools.execute({ id: "call_generation_1_first", toolName: "Chat", input: { action: "poll" } });
  assert.equal(first.ok, true);

  const second = await tools.execute({ id: "call_generation_1_second", toolName: "Chat", input: { action: "poll" } });
  assert.equal(second.ok, true);

  const afterSwitch = await tools.execute({ id: "call_generation_2_first", toolName: "Chat", input: { action: "poll" } });
  assert.equal(afterSwitch.ok, true);
});

async function pollFromUnreadMessage(name: string) {
  const store = createAliceStore(path.join(makeTempDir(name), "alice.sqlite"));
  store.upsertInboundMessage({
    plugin: "feishu",
    externalMessageId: "om_1",
    conversationId: "session-1",
    senderId: "user-1",
    contentType: "text",
    contentText: "already seen",
    createdAt: "2026-05-26T00:00:00.000Z"
  });
  store.markMessagesReadAndCoreProcessed([1], "2026-05-26T00:00:10.000Z", "seen");
  const outbound = store.insertOutboundMessage({
    plugin: "feishu",
    conversationId: "session-1",
    contentType: "text",
    contentText: "assistant sent",
    createdAt: "2026-05-26T00:01:00.000Z"
  });
  const inbound = store.upsertInboundMessage({
    plugin: "feishu",
    externalMessageId: "om_2",
    conversationId: "session-1",
    senderId: "user-1",
    contentType: "text",
    contentText: "user during send",
    createdAt: "2026-05-26T00:02:00.000Z"
  });
  const tools = createMessagingTools({
    store,
    outputRouter: { async send() {} },
    getDefaultTarget: () => ({ plugin: "feishu", sessionId: "session-1" })
  });

  const result = await tools.execute({ id: "call_new_unread_any", toolName: "Chat", input: { action: "poll" } });

  return { inbound, outbound, result, store };
}

test("check_chat new starts at any unread message", async () => {
  const { result } = await pollFromUnreadMessage("messaging-new-unread-any");

  assert.equal(result.ok, true);
});

test("check_chat new marks returned inbound and outbound messages read", async () => {
  const { inbound, outbound, store } = await pollFromUnreadMessage("messaging-new-unread-read-state");
  const messages = store.listMessagesForConversation("session-1", 10);

  assert.equal(Boolean(messages.find((message) => message.id === outbound.id)?.isRead), true);
  assert.equal(messages.find((message) => message.id === outbound.id)?.coreProcessedAt ?? undefined, undefined);
  assert.equal(Boolean(messages.find((message) => message.id === inbound.id)?.isRead), true);
  assert.ok(messages.find((message) => message.id === inbound.id)?.coreProcessedAt);
});

test("check_chat returns current time from configured timezone provider", async () => {
  const store = createAliceStore(path.join(makeTempDir("messaging-current-time"), "alice.sqlite"));
  const tools = createMessagingTools({
    store,
    outputRouter: { async send() {} },
    time: createCurrentTimeProvider("Asia/Shanghai", () => new Date("2026-05-26T04:34:56.789Z")),
    getDefaultTarget: () => ({ plugin: "feishu", sessionId: "session-1" })
  });

  const result = await tools.execute({ id: "call_current_time", toolName: "Chat", input: { action: "poll",  scope: "new" } });

  assert.equal(result.ok, true);
});

function createSleepCocoonTodayTools(name: string, withSleepPointer = true, latestShortMemoryCreatedAtUtc?: string) {
  const store = createAliceStore(path.join(makeTempDir(name), "alice.sqlite"), {
    time: createCurrentTimeProvider("Asia/Shanghai")
  });
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
    ...(withSleepPointer ? { getSleepCocoonEnteredAt: () => "2026-05-25T12:00:00.000" } : {}),
    ...(latestShortMemoryCreatedAtUtc ? { getLatestShortMemoryCreatedAtUtc: () => latestShortMemoryCreatedAtUtc } : {}),
    getDefaultTarget: () => ({ plugin: "feishu", sessionId: "session-1" })
  });

  return tools;
}

test("check_chat today starts ten messages before sleep cocoon pointer", async () => {
  const tools = createSleepCocoonTodayTools("messaging-sleep-cocoon-today");

  const today = await tools.execute({ id: "call_today", toolName: "Chat", input: { action: "poll",  scope: "today" } });
  assert.equal(today.ok, true);
});

test("check_chat today starts at latest short memory when it is later than sleep context", async () => {
  const tools = createSleepCocoonTodayTools(
    "messaging-today-short-memory-later",
    true,
    "2026-05-25T03:05:00.000Z"
  );

  const today = await tools.execute({ id: "call_today_memory_later", toolName: "Chat", input: { action: "poll", scope: "today" } });

  assert.equal(today.ok, true);
  assert.doesNotMatch(String(today.output), /pre sleep context 4/);
  assert.match(String(today.output), /pre sleep context 5/);
  assert.match(String(today.output), /after sleep cocoon/);
});

test("check_chat today keeps sleep context start when it is later than latest short memory", async () => {
  const tools = createSleepCocoonTodayTools(
    "messaging-today-sleep-context-later",
    true,
    "2026-05-25T02:00:00.000Z"
  );

  const today = await tools.execute({ id: "call_today_sleep_later", toolName: "Chat", input: { action: "poll", scope: "today" } });

  assert.equal(today.ok, true);
  assert.doesNotMatch(String(today.output), /after old today anchor/);
  assert.match(String(today.output), /pre sleep context 1/);
});

test("check_chat todayold keeps the old today anchor", async () => {
  const tools = createSleepCocoonTodayTools("messaging-sleep-cocoon-todayold");

  const todayOld = await tools.execute({ id: "call_todayold", toolName: "Chat", input: { action: "poll",  scope: "todayold" } });
  assert.equal(todayOld.ok, true);
});

test("check_chat today uses the old anchor without a sleep cocoon pointer", async () => {
  const toolsWithoutSleepPointer = createSleepCocoonTodayTools("messaging-sleep-cocoon-today-no-pointer", false);

  const todayWithoutSleepPointer = await toolsWithoutSleepPointer.execute({ id: "call_today_no_sleep", toolName: "Chat", input: { action: "poll",  scope: "today" } });
  assert.equal(todayWithoutSleepPointer.ok, true);
});

test("check_chat today is not truncated by the recent message window", async () => {
  const store = createAliceStore(path.join(makeTempDir("messaging-today-not-windowed"), "alice.sqlite"));
  for (let index = 0; index < 520; index += 1) {
    const createdAt = new Date(Date.UTC(2026, 4, 25, 12, index, 0)).toISOString();
    store.upsertInboundMessage({
      plugin: "feishu",
      externalMessageId: `om_after_sleep_${index}`,
      conversationId: "session-1",
      senderId: "user-1",
      contentType: "text",
      contentText: index === 0 ? "first after sleep should remain visible" : `after sleep ${index}`,
      createdAt
    });
  }
  const tools = createMessagingTools({
    store,
    outputRouter: { async send() {} },
    time: createCurrentTimeProvider("UTC", () => new Date("2026-05-25T23:00:00.000Z")),
    getSleepCocoonEnteredAt: () => "2026-05-25T12:00:00.000Z",
    getDefaultTarget: () => ({ plugin: "feishu", sessionId: "session-1" })
  });

  const today = await tools.execute({ id: "call_today_full_range", toolName: "Chat", input: { action: "poll",  scope: "today" } });

  assert.equal(today.ok, true);
});

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
