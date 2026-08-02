import { test } from "node:test";
import assert from "node:assert/strict";
import { createMessageRuntimeRuntime } from "../../../src/apps/api/bootstrap/message-runtime-runtime.js";
import { createMessageRuntime } from "../../../src/contexts/conversation-hub/src/application/ingest-channel-message.js";
import { createAliceStore } from "../../../src/contexts/conversation-hub/src/adapters/sqlite-conversation-store.js";
import type { AgentEvent, AgentOutput } from "../../../src/contexts/agent-loop/src/contracts/agent-contracts.js";
import { audioEvent, imageResourceEvent, makeTempDir, runMessageRuntimeWakeIndicator, textEvent, textEventAt, textOutput, waitFor } from "./message-runtime-helpers.js";

const fs = await import("node:fs");
const path = await import("node:path");

test("messageRuntime_feishuTypingDisabled_skipsFeishuTypingStart", async () => {
  const root = makeTempDir("runtime-feishu-typing-config");
  const store = createAliceStore(path.join(root, "alice.sqlite"));
  const messagingConfigPath = path.join(root, "config", "plugin", "messaging", "config.json");
  fs.mkdirSync(path.dirname(messagingConfigPath), { recursive: true });
  fs.writeFileSync(messagingConfigPath, `${JSON.stringify({
    splitMultilineSendChat: true,
    limitConsecutiveSends: true,
    feishuTypingEmojiEnabled: false,
    mapMarkdownLikeToMarkdown: false
  })}\n`);
  const typingEvents: Array<{ sessionId?: string; typing: boolean }> = [];
  const indicatorTypingEvents: boolean[] = [];
  const runtime = createMessageRuntimeRuntime({
    config: { core: { inboundDebounceMs: 0, heartbeatPaused: false } },
    time: {
      timeZone: "UTC",
      now: () => ({ iso: "2026-05-26T00:00:00.000Z", date: new Date("2026-05-26T00:00:00.000Z") })
    },
    store,
    chatAgent: { clearLLMSession() {}, async prepareEventRun() { return [textOutput("session-1", "ok")]; } },
    agentLoopRuntime: undefined,
    talkRuntime: undefined,
    agentState: {
      tick() {
        return { state: "waiting", intimacy: 50, updatedAt: "2026-05-26T00:00:00.000Z", responseDelayMs: 0 };
      },
      getSnapshot: () => ({ state: "waiting" }),
      onChange: () => () => {},
      canReplyToInbound: () => true,
      canRunHeartbeat: () => true,
      getInboundDelayMs: () => 0,
      noteInboundMessage() {
        return { state: "waiting", intimacy: 50, updatedAt: "2026-05-26T00:00:00.000Z", responseDelayMs: 0 };
      }
    },
    outputRouter: { async sendAll() {} },
    isLLMSessionActive: () => false,
    messagingConfigPath,
    feishu: {
      async setTyping(input: { sessionId?: string; typing: boolean }) {
        typingEvents.push({ sessionId: input.sessionId, typing: input.typing });
      }
    },
    wechat: { async setTyping() {} },
    agentRunIndicator: {
      async setTyping(input: { typing: boolean }) {
        indicatorTypingEvents.push(input.typing);
      }
    },
    initiatedBehaviorRunStore: { finalizeExpiredResponses() {}, markRespondedWithin15m: () => 0 },
    getAgentInitiatedBehaviorPlans: () => [],
    getDefaultMessagingTarget: () => undefined,
    getSleepCocoonGoodnightEvent: () => undefined,
    getSleepCocoonWakeEvent: () => undefined,
    getCalendarReminderEvent: () => undefined,
    queueForceWakeEvent() {},
    appendLog() {},
    appendMessageLog(input) {
      return store.insertMessageLog({ time: new Date().toISOString(), ...input });
    }
  });

  runtime.ingestEvent(textEvent("session-1", "om_1", "hello"));
  await waitFor(() => store.listMessagesForConversation("session-1", 10).some((entry) => entry.direction === "outbound"));

  assert.deepEqual(typingEvents, [{ sessionId: "session-1", typing: false }]);
  assert.deepEqual(indicatorTypingEvents, [true, false]);
});

test("messageRuntime_sleepCocoonWake_createsFreshAgentRunCard", async () => {
  const wakeEvents = await runMessageRuntimeWakeIndicator("sleep_cocoon.wake");

  assert.deepEqual(wakeEvents, ["fresh", "typing:true", "loop", "typing:false"]);
});

test("messageRuntime_sleepCocoonForceWake_skipsFreshAgentRunCard", async () => {
  const forceWakeEvents = await runMessageRuntimeWakeIndicator("sleep_cocoon.force_wake");

  assert.deepEqual(forceWakeEvents, ["typing:true", "loop", "typing:false"]);
});

test("messageRuntime_pendingInboundLogs_sendsOneLlmRequestAndMarksProcessed", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime"), "alice.sqlite"));
  const coreInputs: AgentEvent[] = [];
  const outputs: AgentOutput[] = [textOutput("session-1", "ok")];
  const runtime = createMessageRuntime({
    getDelayMs: () => 10,
    store,
    chatAgent: {
      async prepareEventRun(event) {
        coreInputs.push(event);
        return outputs;
      }
    },
    outputRouter: {
      async sendAll() {}
    },
    appendLog() {},
    appendMessageLog(input) {
      return store.insertMessageLog({ time: new Date().toISOString(), ...input });
    }
  });

  runtime.ingestEvent(textEvent("session-1", "om_1", "hello"));
  runtime.ingestEvent(textEvent("session-1", "om_2", "world"));
  await waitFor(() => coreInputs.length === 1);

  assert.equal(coreInputs.length, 1);
  assert.equal(store.listUnprocessedCoreMessagesForConversation("session-1", 10).length, 0);
});

test("messageRuntime stores inbound image resources under chat_files before inserting message", async () => {
  const root = makeTempDir("runtime-chat-files");
  const store = createAliceStore(path.join(root, "alice.sqlite"));
  const runtime = createMessageRuntime({
    getDelayMs: () => 10_000,
    store,
    chatAgent: {
      async prepareEventRun() {
        return [];
      }
    },
    outputRouter: {
      async sendAll() {}
    },
    chatFilesOutputRoot: path.join(root, "assets", "chat_files"),
    async downloadInboundAttachment(input) {
      assert.equal(input.event.payload.kind, "image");
      assert.equal(input.event.payload.resource?.id, "img_v2_1");
      fs.writeFileSync(input.filePath, "png");
    },
    appendLog() {},
    appendMessageLog(input) {
      return store.insertMessageLog({ time: new Date().toISOString(), ...input });
    }
  });

  await runtime.ingestEvent(imageResourceEvent("session-1", "om_image", "img_v2_1", "hello.png"));

  const [message] = store.listMessagesForConversation("session-1", 10);
  assert.equal(message.contentType, "image");
  assert.equal(message.contentText, "assets/chat_files/2026-05/hello.png");
  assert.deepEqual(JSON.parse(message.contentJson ?? "{}"), {
    kind: "image",
    assetId: "assets/chat_files/2026-05/hello.png"
  });
  assert.equal(fs.readFileSync(path.join(root, "assets", "chat_files", "2026-05", "hello.png"), "utf8"), "png");
});

test("messageRuntime_sameAttachmentNameSameHash_reusesFileNameWithoutSuffix", async () => {
  const root = makeTempDir("runtime-chat-files-same-hash");
  const store = createAliceStore(path.join(root, "alice.sqlite"));
  const runtime = createMessageRuntime({
    getDelayMs: () => 10_000,
    store,
    chatAgent: {
      async prepareEventRun() {
        return [];
      }
    },
    outputRouter: {
      async sendAll() {}
    },
    chatFilesOutputRoot: path.join(root, "assets", "chat_files"),
    async downloadInboundAttachment(input) {
      fs.writeFileSync(input.filePath, "same-content");
    },
    appendLog() {},
    appendMessageLog(input) {
      return store.insertMessageLog({ time: new Date().toISOString(), ...input });
    }
  });

  await runtime.ingestEvent(imageResourceEvent("session-1", "om_1", "img_1", "hello.png"));
  await runtime.ingestEvent(imageResourceEvent("session-1", "om_2", "img_2", "hello.png"));

  const messages = store.listMessagesForConversation("session-1", 10);
  assert.deepEqual(messages.map((message) => message.contentText), [
    "assets/chat_files/2026-05/hello.png",
    "assets/chat_files/2026-05/hello.png"
  ]);
  assert.deepEqual(fs.readdirSync(path.join(root, "assets", "chat_files", "2026-05")).sort(), ["hello.png"]);
});

test("messageRuntime_sameAttachmentNameDifferentHash_appendsNumericSuffix", async () => {
  const root = makeTempDir("runtime-chat-files-diff-hash");
  const store = createAliceStore(path.join(root, "alice.sqlite"));
  const runtime = createMessageRuntime({
    getDelayMs: () => 10_000,
    store,
    chatAgent: {
      async prepareEventRun() {
        return [];
      }
    },
    outputRouter: {
      async sendAll() {}
    },
    chatFilesOutputRoot: path.join(root, "assets", "chat_files"),
    async downloadInboundAttachment(input) {
      fs.writeFileSync(input.filePath, input.event.source.rawMessageId ?? "content");
    },
    appendLog() {},
    appendMessageLog(input) {
      return store.insertMessageLog({ time: new Date().toISOString(), ...input });
    }
  });

  await runtime.ingestEvent(imageResourceEvent("session-1", "om_1", "img_1", "hello.png"));
  await runtime.ingestEvent(imageResourceEvent("session-1", "om_2", "img_2", "hello.png"));

  const messages = store.listMessagesForConversation("session-1", 10);
  assert.deepEqual(messages.map((message) => message.contentText), [
    "assets/chat_files/2026-05/hello.png",
    "assets/chat_files/2026-05/hello_1.png"
  ]);
  assert.deepEqual(fs.readdirSync(path.join(root, "assets", "chat_files", "2026-05")).sort(), ["hello.png", "hello_1.png"]);
});

test("messageRuntime_audioTranscriptInbound_storesVoiceMarkedAudio", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime-audio-inbound"), "alice.sqlite"));
  const runtime = createMessageRuntime({
    getDelayMs: () => 0,
    startHeartbeatPaused: true,
    store,
    chatAgent: {
      async prepareEventRun() {
        return [];
      }
    },
    outputRouter: {
      async sendAll() {}
    },
    appendLog() {},
    appendMessageLog(input) {
      return store.insertMessageLog({ time: new Date().toISOString(), ...input });
    }
  });

  runtime.ingestEvent(audioEvent("session-1", "om_audio_1", "voice-1.opus", "[语音][0:0.020,0:5.000]  晚点见"));

  const stored = store.listMessagesForConversation("session-1", 10)[0];
  assert.equal(stored.contentType, "audio");
  assert.equal(stored.contentText, "[语音]晚点见");
  assert.equal(stored.coreProcessedAt ?? undefined, undefined);
  assert.equal(JSON.parse(stored.contentJson ?? "{}").transcript, "晚点见");
});

test("messageRuntime_audioTranscriptInbound_processesTranscript", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime-audio-process"), "alice.sqlite"));
  const coreInputs: AgentEvent[] = [];
  const runtime = createMessageRuntime({
    getDelayMs: () => 0,
    startHeartbeatPaused: true,
    store,
    chatAgent: {
      async prepareEventRun(event) {
        coreInputs.push(event);
        return [];
      }
    },
    outputRouter: {
      async sendAll() {}
    },
    appendLog() {},
    appendMessageLog(input) {
      return store.insertMessageLog({ time: new Date().toISOString(), ...input });
    }
  });

  runtime.ingestEvent(audioEvent("session-1", "om_audio_1", "voice-1.opus", "[语音][0:0.020,0:5.000]  晚点见"));

  await runtime.processNow();

  assert.equal(coreInputs.length, 1);
  assert.equal(coreInputs[0].type, "message.audio");
  assert.equal(coreInputs[0].payload.kind, "text");
  assert.doesNotMatch(coreInputs[0].payload.kind === "text" ? coreInputs[0].payload.text : "", /0:0\.020|0:5\.000/);
  assert.equal(store.listUnprocessedCoreMessagesForConversation("session-1", 10).length, 0);
});

test("messageRuntime_agentStateDelay_recordsInboundActivity", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime-state-delay"), "alice.sqlite"));
  const coreInputs: AgentEvent[] = [];
  let inboundActivity = 0;
  const runtime = createMessageRuntime({
    getDelayMs: () => 10_000,
    agentState: {
      canReplyToInbound: () => true,
      canRunHeartbeat: () => true,
      tick() {
        return {
          state: "waiting",
          intimacy: 50,
          updatedAt: "2026-05-24T00:00:00.000Z",
          responseDelayMs: 10
        };
      },
      getInboundDelayMs: () => 10,
      onChange: () => () => {},
      noteInboundMessage() {
        inboundActivity += 1;
        return {
          state: "waiting",
          intimacy: 50,
          updatedAt: "2026-05-24T00:00:00.000Z",
          responseDelayMs: 10
        };
      }
    },
    store,
    chatAgent: {
      async prepareEventRun(event) {
        coreInputs.push(event);
        return [textOutput("session-1", "ok")];
      }
    },
    outputRouter: {
      async sendAll() {}
    },
    appendLog() {},
    appendMessageLog(input) {
      return store.insertMessageLog({ time: new Date().toISOString(), ...input });
    }
  });

  runtime.ingestEvent(textEvent("session-1", "om_1", "hello"));
  await waitFor(() => coreInputs.length === 1);

  assert.equal(inboundActivity, 1);
});

test("messageRuntime_pendingMessageBelowSavedDelay_waitsUntilDelayExceeded", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime-heartbeat-delay"), "alice.sqlite"));
  const coreInputs: AgentEvent[] = [];
  let current = new Date("2026-05-24T00:00:00.000Z");
  let heartbeatTicks = 0;
  const runtime = createMessageRuntime({
    getDelayMs: () => 10_000,
    getHeartbeatIntervalMs: () => 10,
    onHeartbeatTick() {
      heartbeatTicks += 1;
    },
    now: () => current,
    agentState: {
      canReplyToInbound: () => true,
      canRunHeartbeat: () => true,
      tick() {
        return {
          state: "waiting",
          intimacy: 50,
          updatedAt: current.toISOString(),
          responseDelayMs: 10_000
        };
      },
      getInboundDelayMs: () => 10_000,
      onChange: () => () => {},
      noteInboundMessage() {
        return {
          state: "waiting",
          intimacy: 50,
          updatedAt: current.toISOString(),
          responseDelayMs: 10_000
        };
      }
    },
    store,
    chatAgent: {
      async prepareEventRun(event) {
        coreInputs.push(event);
        return [textOutput("session-1", "ok")];
      }
    },
    outputRouter: {
      async sendAll() {}
    },
    appendLog() {},
    appendMessageLog(input) {
      return store.insertMessageLog({ time: new Date().toISOString(), ...input });
    }
  });

  runtime.ingestEvent(textEventAt("session-1", "om_1", "hello", current.toISOString()));
  await waitFor(() => heartbeatTicks > 0);
  assert.equal(coreInputs.length, 0);

  current = new Date("2026-05-24T00:00:10.000Z");
  await waitFor(() => coreInputs.length === 1);
});

test("messageRuntime_stateCannotReply_doesNotCountDelay", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime-away-gate"), "alice.sqlite"));
  const coreInputs: AgentEvent[] = [];
  let canReply = false;
  let tickCalls = 0;
  let onStateChange: (() => void) | undefined;
  const runtime = createMessageRuntime({
    getDelayMs: () => 10,
    getHeartbeatIntervalMs: () => 10,
    now: () => new Date("2026-05-24T01:00:00.000Z"),
    agentState: {
      canReplyToInbound: () => canReply,
      canRunHeartbeat: () => canReply,
      tick() {
        tickCalls += 1;
        return {
          state: canReply ? "waiting" : "away",
          intimacy: 50,
          updatedAt: "2026-05-24T01:00:00.000Z",
          responseDelayMs: 10
        };
      },
      getInboundDelayMs: () => 10,
      onChange(listener) {
        onStateChange = () => listener({
          state: canReply ? "waiting" : "away",
          intimacy: 50,
          updatedAt: "2026-05-24T01:00:00.000Z",
          responseDelayMs: 10
        });
        return () => {
          onStateChange = undefined;
        };
      },
      noteInboundMessage() {
        return {
          state: canReply ? "waiting" : "away",
          intimacy: 50,
          updatedAt: "2026-05-24T01:00:00.000Z",
          responseDelayMs: 10
        };
      }
    },
    store,
    chatAgent: {
      async prepareEventRun(event) {
        coreInputs.push(event);
        return [textOutput("session-1", "ok")];
      }
    },
    outputRouter: {
      async sendAll() {}
    },
    appendLog() {},
    appendMessageLog(input) {
      return store.insertMessageLog({ time: new Date().toISOString(), ...input });
    }
  });

  runtime.ingestEvent(textEventAt("session-1", "om_1", "hello", "2026-05-24T00:00:00.000Z"));
  await waitFor(() => tickCalls > 0);
  assert.equal(coreInputs.length, 0);

  canReply = true;
  onStateChange?.();
  await waitFor(() => coreInputs.length === 1);
});

test("messageRuntime_activeLlmSession_waitsBeforeProcessing", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime-active-llm-gate"), "alice.sqlite"));
  const coreInputs: AgentEvent[] = [];
  let llmActive = true;
  const runtime = createMessageRuntime({
    getDelayMs: () => 0,
    getHeartbeatIntervalMs: () => 10,
    isLLMSessionActive: () => llmActive,
    store,
    chatAgent: {
      async prepareEventRun(event) {
        coreInputs.push(event);
        return [textOutput("session-1", "ok")];
      }
    },
    outputRouter: {
      async sendAll() {}
    },
    appendLog() {},
    appendMessageLog(input) {
      return store.insertMessageLog({ time: new Date().toISOString(), ...input });
    }
  });

  runtime.ingestEvent(textEvent("session-1", "om_1", "hello"));
  assert.equal(coreInputs.length, 0);
  assert.deepEqual(runtime.getStatus().pendingSessions, ["session-1"]);
  assert.equal(store.listUnprocessedCoreMessagesForConversation("session-1", 10).length, 1);

  llmActive = false;
  await runtime.processNow();
  assert.equal(coreInputs.length, 1);
  assert.equal(store.listUnprocessedCoreMessagesForConversation("session-1", 10).length, 0);
});

test("messageRuntime_flushAllWithGatedInbound_stopsHeartbeatWithoutProcessing", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime-flush-gated"), "alice.sqlite"));
  const coreInputs: AgentEvent[] = [];
  const runtime = createMessageRuntime({
    getDelayMs: () => 10,
    getHeartbeatIntervalMs: () => 10,
    now: () => new Date("2026-05-24T01:00:00.000Z"),
    agentState: {
      canReplyToInbound: () => false,
      canRunHeartbeat: () => false,
      tick() {
        return {
          state: "sleeping",
          intimacy: 50,
          updatedAt: "2026-05-24T01:00:00.000Z",
          responseDelayMs: 10
        };
      },
      getInboundDelayMs: () => 10,
      onChange: () => () => {},
      noteInboundMessage() {
        return {
          state: "sleeping",
          intimacy: 50,
          updatedAt: "2026-05-24T01:00:00.000Z",
          responseDelayMs: 10
        };
      }
    },
    store,
    chatAgent: {
      async prepareEventRun(event) {
        coreInputs.push(event);
        return [textOutput("session-1", "ok")];
      }
    },
    outputRouter: {
      async sendAll() {}
    },
    appendLog() {},
    appendMessageLog(input) {
      return store.insertMessageLog({ time: new Date().toISOString(), ...input });
    }
  });

  runtime.ingestEvent(textEventAt("session-1", "om_1", "hello", "2026-05-24T00:00:00.000Z"));
  await runtime.flushAll();

  assert.equal(coreInputs.length, 0);
  assert.equal(store.listUnprocessedCoreMessagesForConversation("session-1", 10).length, 1);
});
