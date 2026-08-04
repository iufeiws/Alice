import { test } from "node:test";
import assert from "node:assert/strict";
import { createMessageRuntime } from "../../../src/contexts/conversation-hub/src/application/ingest-channel-message.js";
import { createAliceStore } from "../../../src/contexts/conversation-hub/src/adapters/sqlite-conversation-store.js";
import type { ProcessRestartContinuationRecord } from "../../../src/contexts/agent-loop/src/adapters/json-process-restart-continuation-store.js";
import { createRestartTools } from "../../../src/capabilities/tools/restart/src/index.js";
import { loadConfig } from "../../../src/apps/api/bootstrap/app-config-runtime.js";
import { createOutputRouter } from "../../../src/platform/output-router/src/index.js";
import { createCurrentTimeProvider } from "../../../src/platform/time/src/index.js";
import { staticPromptFingerprint } from "../../../src/contexts/agent-profile/src/application/build-system-prompt.js";
import { createChatAgent, testPromptProfile } from "../agent-loop/agent-tools-helpers.js";
import { testPromptRuntime } from "../../helpers/prompt-runtime.js";
import { makeTempDir, textEvent, textOutput } from "./message-runtime-helpers.js";

const path = await import("node:path");

test("message runtime resumes a persisted restart continuation once and completes its original inbound batch", async () => {
  const store = createAliceStore(path.join(makeTempDir("restart-continuation"), "alice.sqlite"));
  await Promise.resolve();
  const inbound = textEvent("session-1", "message-1", "restart after deploy");
  store.upsertInboundMessage({
    plugin: "feishu",
    externalMessageId: "message-1",
    conversationId: "session-1",
    senderId: "user",
    senderRole: "user",
    contentType: "text",
    contentText: "restart after deploy",
    contentJson: "{}",
    createdAt: inbound.meta.receivedAt,
    lastEventAt: inbound.meta.receivedAt
  });
  const pendingId = store.listUnprocessedCoreMessagesForConversation("session-1", 10)[0].id;
  let record = {
    version: 1,
    sessionId: 7,
    toolCallId: "restart_call",
    restartCompleted: false,
    event: {
      ...inbound,
      meta: { ...inbound.meta, raw: { pendingIds: [pendingId] } }
    },
    continuation: { version: 1 },
    createdAt: "2026-05-24T00:00:00.000"
  } as ProcessRestartContinuationRecord | undefined;
  const resumedEvents: string[] = [];
  const continuationStore = {
    read: () => record,
    save(value: ProcessRestartContinuationRecord) {
      record = value;
    },
    clear(toolCallId: string) {
      if (record?.toolCallId !== toolCallId) return false;
      record = undefined;
      return true;
    }
  };
  const runtime = createMessageRuntime({
    getDelayMs: () => 0,
    startHeartbeatPaused: true,
    now: () => new Date("2026-05-24T00:01:00.000Z"),
    store,
    processRestartContinuationStore: continuationStore,
    chatAgent: {
      async prepareEventRun(event) {
        resumedEvents.push(event.id);
        continuationStore.clear("restart_call");
        return [textOutput("session-1", "resumed")];
      }
    },
    outputRouter: { async sendAll() {} },
    appendLog() {},
    appendMessageLog(input) {
      return store.insertMessageLog({ time: "2026-05-24T00:01:00.000", ...input });
    }
  });

  await runtime.recoverProcessRestartContinuation();
  await runtime.recoverProcessRestartContinuation();

  assert.deepEqual(resumedEvents, [inbound.id]);
  assert.equal(store.listUnprocessedCoreMessagesForConversation("session-1", 10).length, 0);
  await runtime.flushAll();
});

test("process restart recovery resumes a matching persisted restart continuation", async () => {
  const store = createAliceStore(path.join(makeTempDir("restart-session-reconcile"), "alice.sqlite"));
  await Promise.resolve();
  const inbound = textEvent("session-1", "message-legacy", "restart after deploy");
  store.upsertInboundMessage({
    plugin: "feishu",
    externalMessageId: "message-legacy",
    conversationId: "session-1",
    senderId: "user",
    senderRole: "user",
    contentType: "text",
    contentText: "restart after deploy",
    contentJson: "{}",
    createdAt: inbound.meta.receivedAt,
    lastEventAt: inbound.meta.receivedAt
  });
  const pendingId = store.listUnprocessedCoreMessagesForConversation("session-1", 10)[0].id;
  const restartAssistantMessage = {
    role: "assistant" as const,
    content: "",
    reasoningContent: "",
    toolCalls: [{
      id: "restart_call",
      type: "function" as const,
      function: { name: "restart", arguments: "{}" }
    }]
  };
  let record = {
    version: 1,
    sessionId: 8,
    toolCallId: "restart_call",
    restartCompleted: false,
    event: { ...inbound, meta: { ...inbound.meta, raw: { pendingIds: [pendingId] } } },
    continuation: {
      version: 1,
      messages: [],
      round: 0,
      replyRound: 0,
      totalToolCallCount: 1,
      replyToolCallCount: 1,
      invalidateSession: false,
      result: { message: restartAssistantMessage },
      completeAfterToolCalls: false,
      interruptedCallIndex: 0,
      executedCalls: restartAssistantMessage.toolCalls,
      toolMessages: [],
      reachedToolCallLimit: false,
      resetSession: false,
      continueAfterReset: false,
      yieldReturn: false
    },
    createdAt: "2026-05-24T00:00:00.000"
  } as ProcessRestartContinuationRecord | undefined;
  const continuationStore = {
    read: () => record,
    save(value: ProcessRestartContinuationRecord) {
      record = value;
    },
    clear(toolCallId: string) {
      if (record?.toolCallId !== toolCallId) return false;
      record = undefined;
      return true;
    }
  };
  const time = createCurrentTimeProvider("UTC", () => new Date("2026-05-24T00:01:00.000Z"));
  const promptProfile = testPromptProfile();
  const promptRenderer = testPromptRuntime();
  let currentSession: any = {
    id: 8,
    messages: [restartAssistantMessage],
    staticPromptFingerprint: staticPromptFingerprint(promptProfile, { renderer: promptRenderer, event: inbound, time }),
    staticPromptMessageCount: 0,
    requestTimestamps: [],
    mode: "normal",
    modeStaticMessages: [],
    modeStaticTokenEstimate: 0
  };
  let requestCount = 0;
  const chatAgent = createChatAgent({
    config: loadConfig({ LLM_MODEL: "test-model", LLM_TOKEN_PRESSURE_CONTEXT_IMPORTANCE: "1" }),
    time,
    getPromptProfile: () => promptProfile,
    getPromptRenderer: () => promptRenderer,
    llm: {
      async chat() {
        requestCount += 1;
        return { message: { role: "assistant", content: "resumed" } };
      }
    },
    outputRouter: createOutputRouter(),
    intentRouter: { route: () => ({ kind: "chat" as const, text: "restart after deploy" }) },
    sessionResolver: { resolve: async () => "session-1" },
    policy: { check: async () => ({ allowed: true }) },
    tools: [createRestartTools({ async restart() {} })],
    loadLLMSession: () => currentSession,
    onLLMSessionUpdated(session) { currentSession = session; },
    createLLMSessionId: () => 9,
    processRestartContinuationStore: continuationStore
  });
  const runtime = createMessageRuntime({
    getDelayMs: () => 0,
    startHeartbeatPaused: true,
    now: () => new Date("2026-05-24T00:01:00.000Z"),
    store,
    processRestartContinuationStore: continuationStore,
    chatAgent,
    outputRouter: { async sendAll() {} },
    appendLog() {},
    appendMessageLog(input) {
      return store.insertMessageLog({ time: "2026-05-24T00:01:00.000", ...input });
    }
  });

  await runtime.recoverProcessRestartContinuation();

  assert.equal(requestCount, 1);
  assert.equal(record, undefined);
  assert.equal(store.listUnprocessedCoreMessagesForConversation("session-1", 10).length, 0);
  await runtime.flushAll();
});

test("process restart recovery abandons the interrupted event when the checkpoint session id mismatches", async () => {
  const store = createAliceStore(path.join(makeTempDir("restart-session-invalid"), "alice.sqlite"));
  await Promise.resolve();
  const inbound = textEvent("session-1", "message-invalid", "restart after deploy");
  store.upsertInboundMessage({
    plugin: "feishu",
    externalMessageId: "message-invalid",
    conversationId: "session-1",
    senderId: "user",
    senderRole: "user",
    contentType: "text",
    contentText: "restart after deploy",
    contentJson: "{}",
    createdAt: inbound.meta.receivedAt,
    lastEventAt: inbound.meta.receivedAt
  });
  const pendingId = store.listUnprocessedCoreMessagesForConversation("session-1", 10)[0].id;
  const restartAssistantMessage = {
    role: "assistant" as const,
    content: "",
    reasoningContent: "",
    toolCalls: [{
      id: "restart_call",
      type: "function" as const,
      function: { name: "restart", arguments: "{}" }
    }]
  };
  let record = {
    version: 1,
    sessionId: 7,
    toolCallId: "restart_call",
    restartCompleted: false,
    event: { ...inbound, meta: { ...inbound.meta, raw: { pendingIds: [pendingId] } } },
    continuation: {
      version: 1,
      messages: [],
      round: 0,
      replyRound: 0,
      totalToolCallCount: 1,
      replyToolCallCount: 1,
      invalidateSession: false,
      result: { message: restartAssistantMessage },
      completeAfterToolCalls: false,
      interruptedCallIndex: 0,
      executedCalls: restartAssistantMessage.toolCalls,
      toolMessages: [],
      reachedToolCallLimit: false,
      resetSession: false,
      continueAfterReset: false,
      yieldReturn: false
    },
    createdAt: "2026-05-24T00:00:00.000"
  } as ProcessRestartContinuationRecord | undefined;
  const continuationStore = {
    read: () => record,
    save(value: ProcessRestartContinuationRecord) { record = value; },
    clear(toolCallId: string) {
      if (record?.toolCallId !== toolCallId) return false;
      record = undefined;
      return true;
    }
  };
  const time = createCurrentTimeProvider("UTC", () => new Date("2026-05-24T00:01:00.000Z"));
  const promptProfile = testPromptProfile();
  const promptRenderer = testPromptRuntime();
  let currentSession: any = {
    id: 8,
    messages: [{ role: "assistant", content: "unrelated response" }],
    staticPromptFingerprint: staticPromptFingerprint(promptProfile, { renderer: promptRenderer, event: inbound, time }),
    staticPromptMessageCount: 0,
    requestTimestamps: [],
    mode: "normal",
    modeStaticMessages: [],
    modeStaticTokenEstimate: 0
  };
  const clearedReasons: string[] = [];
  let requestCount = 0;
  const chatAgent = createChatAgent({
    config: loadConfig({ LLM_MODEL: "test-model", LLM_TOKEN_PRESSURE_CONTEXT_IMPORTANCE: "1" }),
    time,
    getPromptProfile: () => promptProfile,
    getPromptRenderer: () => promptRenderer,
    llm: {
      async chat() {
        requestCount += 1;
        return { message: { role: "assistant", content: "fresh response" } };
      }
    },
    outputRouter: createOutputRouter(),
    intentRouter: { route: () => ({ kind: "chat" as const, text: "restart after deploy" }) },
    sessionResolver: { resolve: async () => "session-1" },
    policy: { check: async () => ({ allowed: true }) },
    tools: [createRestartTools({ async restart() {} })],
    loadLLMSession: () => currentSession,
    onLLMSessionUpdated(session) { currentSession = session; },
    onLLMSessionCleared(reason) {
      clearedReasons.push(reason);
      currentSession = undefined;
    },
    createLLMSessionId: () => 9,
    processRestartContinuationStore: continuationStore
  });
  const runtime = createMessageRuntime({
    getDelayMs: () => 0,
    startHeartbeatPaused: true,
    now: () => new Date("2026-05-24T00:01:00.000Z"),
    store,
    processRestartContinuationStore: continuationStore,
    chatAgent,
    outputRouter: { async sendAll() {} },
    appendLog() {},
    appendMessageLog(input) {
      return store.insertMessageLog({ time: "2026-05-24T00:01:00.000", ...input });
    }
  });

  await runtime.recoverProcessRestartContinuation();

  assert.equal(requestCount, 0);
  assert.deepEqual(clearedReasons, ["process_restart_recovery_failed"]);
  assert.equal(currentSession, undefined);
  assert.equal(record, undefined);
  assert.equal(store.listUnprocessedCoreMessagesForConversation("session-1", 10).length, 0);
  await runtime.flushAll();
});
