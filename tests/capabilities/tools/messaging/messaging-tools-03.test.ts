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

  const result = await tools.execute({ id: "call_shell_switch", toolName: "Chat", input: { action: "poll" } });
  assert.equal(result.ok, true);
});

test("store searchMessages keeps persisted message FTS available", async () => {
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

  const hits = store.searchMessages({ plugin: "feishu", query: "project alpha", direction: "backward", limit: 3 });

  assert.equal(hits.length, 1);
  assert.equal(hits[0].contentText, "project alpha decision");
});

async function sendDefaultMultilineChat(name: string) {
  const store = createAliceStore(path.join(makeTempDir(name), "alice.sqlite"));
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

  await tools.execute({ id: "call_check_today", toolName: "Chat", input: { action: "poll" } });
  const result = await tools.execute({
    id: "call_send",
    toolName: "Chat", input: { action: "send",  content: "one\n\ntwo" }
  });

  return { result, sent, store, tools };
}

test("send_chat defaults to message", async () => {
  const { result } = await sendDefaultMultilineChat("messaging-send-default-message");

  assert.equal(result.ok, true);
});

test("send_chat splits newline text into multiple sends", async () => {
  const { sent } = await sendDefaultMultilineChat("messaging-send-split-newline");

  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map((output) => output.content.kind === "text" ? output.content.text : ""), ["one", "two"]);
});

test("send_chat result omits old poll context", async () => {
  const { result } = await sendDefaultMultilineChat("messaging-send-no-old-context");

  assert.equal(result.ok, true);
});

test("send_chat persists outbound message ids and sender name", async () => {
  const { store } = await sendDefaultMultilineChat("messaging-send-persist");
  const stored = store.listMessagesForConversation("session-1", 10).filter((message) => message.direction === "outbound");

  assert.equal(stored.length, 2);
  assert.deepEqual(stored.map((message) => message.externalMessageId), ["sent_1", "sent_2"]);
  assert.deepEqual(stored.map((message) => message.senderName), ["shell", "shell"]);
});

test("send_chat can keep newline text in one send from messaging config", async () => {
  const store = createAliceStore(path.join(makeTempDir("messaging-send-no-split"), "alice.sqlite"));
  seedUserInbound(store, "session-1", "feishu");
  const sent: AgentOutput[] = [];
  const tools = createMessagingTools({
    store,
    sleep: async () => {},
    config: { splitMultilineSendChat: false, limitConsecutiveSends: true, feishuTypingEmojiEnabled: true, mapMarkdownLikeToMarkdown: false },
    outputRouter: {
      async send(output) {
        sent.push(output);
        return { messageId: `sent_${sent.length}` };
      }
    },
    getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" })
  });

  const result = await tools.execute({
    id: "call_send_no_split",
    toolName: "Chat", input: { action: "send",  type: "message", content: "one\n\ntwo", speaker: "shell" }
  });

  assert.equal(result.ok, true);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent.map((output) => output.content.kind === "text" ? output.content.text : ""), ["one\ntwo"]);
});

async function sendFeishuCoreMarkdown(name: string) {
  const store = createAliceStore(path.join(makeTempDir(name), "alice.sqlite"));
  seedUserInbound(store, "session-1", "feishu");
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

  const result = await tools.execute({
    id: "call_send_core",
    toolName: "Chat", input: { action: "send",  content: "core text\nsecond", speaker: "core" }
  });

  return { result, sent, store };
}

test("send_chat sends feishu core message as markdown", async () => {
  const { result, sent } = await sendFeishuCoreMarkdown("messaging-send-core-markdown");

  assert.equal(result.ok, true);
  assert.deepEqual(sent.map((output) => output.content.kind), ["markdown"]);
});

test("send_chat stores feishu core message without render markup", async () => {
  const { store } = await sendFeishuCoreMarkdown("messaging-send-core-markdown-store");
  const stored = store.listMessagesForConversation("session-1", 10).filter((message) => message.direction === "outbound");

  assert.deepEqual(stored.map((message) => message.contentType), ["markdown"]);
  assert.deepEqual(stored.map((message) => message.senderName), ["core"]);
});

async function sendFeishuMarkdownLike(name: string, enabled: boolean, content: string) {
  const store = createAliceStore(path.join(makeTempDir(name), "alice.sqlite"));
  seedUserInbound(store, "session-1", "feishu");
  const sent: AgentOutput[] = [];
  const tools = createMessagingTools({
    store,
    time: createCurrentTimeProvider("UTC", () => new Date("2026-05-26T00:00:00.000Z")),
    sleep: async () => {},
    config: { splitMultilineSendChat: true, limitConsecutiveSends: true, feishuTypingEmojiEnabled: true, mapMarkdownLikeToMarkdown: enabled },
    outputRouter: {
      async send(output) {
        sent.push(output);
        return { messageId: `sent_${sent.length}` };
      }
    },
    getDefaultTarget: () => ({ plugin: "feishu", channelId: "chat-1", sessionId: "session-1" })
  });

  const result = await tools.execute({
    id: "call_send_md_like",
    toolName: "Chat", input: { action: "send",  type: "message", content, speaker: "shell" }
  });

  return { result, sent, store };
}

test("send_chat maps markdown-like message to markdown when config enabled", async () => {
  const { result, sent } = await sendFeishuMarkdownLike("messaging-send-markdown-like-on", true, "**加粗**内容");

  assert.equal(result.ok, true);
  assert.deepEqual(sent.map((output) => output.content.kind), ["markdown"]);
});

test("send_chat keeps markdown-like message as text when config disabled", async () => {
  const { result, sent } = await sendFeishuMarkdownLike("messaging-send-markdown-like-off", false, "**加粗**内容");

  assert.equal(result.ok, true);
  assert.deepEqual(sent.map((output) => output.content.kind), ["text"]);
});

test("send_chat sends multiline markdown-like message as single markdown when config enabled", async () => {
  const { result, sent } = await sendFeishuMarkdownLike("messaging-send-markdown-like-multiline", true, "## 计划\n- 买水\n- 充电");

  assert.equal(result.ok, true);
  assert.deepEqual(sent.map((output) => output.content.kind), ["markdown"]);
  assert.equal(sent[0].content.kind === "markdown" ? sent[0].content.markdown : "", "## 计划\n- 买水\n- 充电");
});

test("send_chat maps messages with more than three lines to markdown when config enabled", async () => {
  const content = "第一行\n第二行\n第三行\n第四行";
  const { result, sent } = await sendFeishuMarkdownLike("messaging-send-more-than-three-lines", true, content);

  assert.equal(result.ok, true);
  assert.deepEqual(sent.map((output) => output.content.kind), ["markdown"]);
  assert.equal(sent[0].content.kind === "markdown" ? sent[0].content.markdown : "", content);
});

test("send_chat with config enabled still splits plain text messages", async () => {
  const { sent } = await sendFeishuMarkdownLike("messaging-send-markdown-like-plain", true, "one\n\ntwo");

  assert.deepEqual(sent.map((output) => output.content.kind === "text" ? output.content.text : ""), ["one", "two"]);
});

test("send_chat keeps wechat markdown-like message as text when config enabled", async () => {
  const store = createAliceStore(path.join(makeTempDir("messaging-send-markdown-like-wechat"), "alice.sqlite"));
  seedUserInbound(store, "wechat:dm:wx-user", "wechat");
  const sent: AgentOutput[] = [];
  const tools = createMessagingTools({
    store,
    sleep: async () => {},
    config: { splitMultilineSendChat: true, limitConsecutiveSends: true, feishuTypingEmojiEnabled: true, mapMarkdownLikeToMarkdown: true },
    outputRouter: {
      async send(output) {
        sent.push(output);
        return { messageId: `sent_${sent.length}` };
      }
    },
    getDefaultTarget: () => ({ plugin: "wechat", userId: "wx-user", sessionId: "wechat:dm:wx-user" })
  });

  const result = await tools.execute({
    id: "call_send_md_like_wechat",
    toolName: "Chat", input: { action: "send",  type: "message", content: "**加粗**内容" }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(sent.map((output) => output.content.kind), ["text"]);
});

test("send_chat blocks when the user has not replied recently", async () => {
  const store = createAliceStore(path.join(makeTempDir("messaging-send-wait-user"), "alice.sqlite"));
  for (let index = 0; index < 10; index += 1) {
    store.insertOutboundMessage({
      plugin: "wechat",
      conversationId: "wechat:dm:wx-user",
      contentType: "text",
      contentText: `sent ${index + 1}`,
      createdAt: new Date(Date.parse("2026-05-26T00:00:00.000Z") + index).toISOString()
    });
  }
  let sendCalls = 0;
  const tools = createMessagingTools({
    store,
    outputRouter: {
      async send() {
        sendCalls += 1;
      }
    },
    getDefaultTarget: () => ({ plugin: "wechat", userId: "wx-user", sessionId: "wechat:dm:wx-user" })
  });

  const result = await tools.execute({
    id: "call_send_wait_user",
    toolName: "Chat", input: { action: "send",  type: "message", content: "should wait" }
  });

  assert.equal(result.ok, false);
  assert.equal(sendCalls, 0);
  assert.equal(store.listMessagesForConversation("wechat:dm:wx-user", 20).filter((message) => message.direction === "outbound").length, 10);
});

test("send_chat can disable consecutive-send limit from messaging config", async () => {
  const store = createAliceStore(path.join(makeTempDir("messaging-send-no-wait-user"), "alice.sqlite"));
  for (let index = 0; index < 10; index += 1) {
    store.insertOutboundMessage({
      plugin: "wechat",
      conversationId: "wechat:dm:wx-user",
      contentType: "text",
      contentText: `sent ${index + 1}`,
      createdAt: new Date(Date.parse("2026-05-26T00:00:00.000Z") + index).toISOString()
    });
  }
  let sendCalls = 0;
  const tools = createMessagingTools({
    store,
    config: { splitMultilineSendChat: true, limitConsecutiveSends: false, feishuTypingEmojiEnabled: true, mapMarkdownLikeToMarkdown: false },
    outputRouter: {
      async send() {
        sendCalls += 1;
      }
    },
    getDefaultTarget: () => ({ plugin: "wechat", userId: "wx-user", sessionId: "wechat:dm:wx-user" })
  });

  const result = await tools.execute({
    id: "call_send_no_wait_user",
    toolName: "Chat", input: { action: "send",  type: "message", content: "should send", speaker: "shell" }
  });

  assert.equal(result.ok, true);
  assert.equal(sendCalls, 1);
});

function createParentheticalFilterTools(name: string) {
  const store = createAliceStore(path.join(makeTempDir(name), "alice.sqlite"));
  seedUserInbound(store, "wechat:dm:wx-user", "wechat");
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

  return { sent, store, tools };
}

async function sendParentheticalFilteredMessage(name: string) {
  const { sent, store, tools } = createParentheticalFilterTools(name);

  const result = await tools.execute({
    id: "call_send_filter_parentheses",
    toolName: "Chat", input: { action: "send",  type: "message", content: "one(不发送)\n(整行不发送)\ntwo（也不发送）" }
  });

  return { result, sent, store, tools };
}

test("send_chat preserves parenthetical text when sending", async () => {
  const { result, sent } = await sendParentheticalFilteredMessage("messaging-send-filter-parentheses-send");

  assert.equal(result.ok, true);
  assert.deepEqual(sent.map((output) => output.content.kind === "text" ? output.content.text : ""), ["one(不发送)", "(整行不发送)", "two（也不发送）"]);
});

test("send_chat preserves parenthetical text before storing", async () => {
  const { store } = await sendParentheticalFilteredMessage("messaging-send-filter-parentheses-store");
  const stored = store.listMessagesForConversation("wechat:dm:wx-user", 10).filter((message) => message.direction === "outbound");

  assert.deepEqual(stored.map((message) => message.contentText), ["one(不发送)", "(整行不发送)", "two（也不发送）"]);
});

test("send_chat accepts content made only of parenthetical text", async () => {
  const { sent, tools } = createParentheticalFilterTools("messaging-send-filter-parentheses-empty");

  const emptyResult = await tools.execute({
    id: "call_send_filter_parentheses_empty",
    toolName: "Chat", input: { action: "send",  type: "message", content: "(只是一段旁白)" }
  });

  assert.equal(emptyResult.ok, true);
  assert.deepEqual(sent.map((output) => output.content.kind === "text" ? output.content.text : ""), ["(只是一段旁白)"]);
});

async function sendDsmlFilteredMessage(name: string) {
  const store = createAliceStore(path.join(makeTempDir(name), "alice.sqlite"));
  seedUserInbound(store, "feishu:dm:ou-user", "feishu");
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
    toolName: "Chat", input: { action: "send",  type: "message", content: "one\n<｜｜DSML｜｜parameter name=\"type\" string=\"true\">message\ntwo" }
  });

  return { result, sent, store };
}

test("send_chat filters DSML markup lines before sending", async () => {
  const { result, sent } = await sendDsmlFilteredMessage("messaging-send-filter-dsml-send");

  assert.equal(result.ok, true);
  assert.deepEqual(sent.map((output) => output.content.kind === "text" ? output.content.text : ""), ["one", "two"]);
});

test("send_chat filters DSML markup lines before storing", async () => {
  const { store } = await sendDsmlFilteredMessage("messaging-send-filter-dsml-store");
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
