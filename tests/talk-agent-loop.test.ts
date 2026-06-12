import { test } from "node:test";
import assert from "node:assert/strict";
import { createTalkAgentLoopForSession } from "../src/contexts/agent-loop/src/application/run-talk-loop.js";
import { runAgentFunctionCallLoop } from "../src/contexts/agent-loop/src/runtime/agent-loop-runtime.js";
import { defaultTalkOutputReadyChars } from "../src/contexts/talk-session/src/application/talk-session-runtime.js";
import { defaultPromptProfile } from "../src/contexts/agent-profile/src/application/build-system-prompt.js";
import { createCurrentTimeProvider } from "../src/platform/time/src/index.js";
import type { LLMClient } from "../src/contexts/llm-gateway/src/index.js";

async function runPreparedTalkAgentLoop(controller: ReturnType<typeof createTalkAgentLoopForSession>, sessionId: string): Promise<void> {
  const prepared = await controller.prepareTalkAgentLoopForSession(sessionId);
  if (!prepared) return;
  try {
    const spec = await Promise.resolve(prepared.prepare ? prepared.prepare() : prepared.spec);
    if (!spec || Array.isArray(spec)) return;
    prepared.complete(await runAgentFunctionCallLoop(spec));
  } catch (error) {
    await prepared.onError?.(error);
  } finally {
    await prepared.dispose?.();
  }
}

test("talk loop waits for voice output backpressure and runs one LLM round per launch", async () => {
  let pendingChars = defaultTalkOutputReadyChars;
  let sleepCalls = 0;
  let sendCalls = 0;
  let activeSession: any;
  const sentMessages: unknown[][] = [];
  const finishedOutputs: string[] = [];
  const logs: Array<{ level: string; message: string }> = [];
  const controller = createTalkAgentLoopForSession({
    isActiveTalkLLMSession: () => true,
    getActiveTalkLLMSessionId: () => "session-backpressure",
    isTalkSessionOpen: () => true,
    pendingVoiceOutputCharCount: () => pendingChars,
    isForegroundPlaybackIdle: () => true,
    getTalkPromptProfile: () => ({ ...defaultPromptProfile(), layers: [], appendLayers: [] }),
    time: createCurrentTimeProvider("UTC", () => new Date("2026-06-08T00:00:00.000Z")),
    dailyShellStore: {
      render: () => "",
      get: () => undefined
    },
    getAppearanceDescription: () => undefined,
    memoryStore: { read: () => undefined },
    diaryStore: { latestWakeBoundary: () => undefined },
    setLoopPrefixMessageCount: () => {},
    buildNextLoopMessagePatch: () => ({ replaceFrom: 0, messages: [{ role: "user", content: "hello" }] }),
    loadActiveTalkLLMSessionTranscript: () => activeSession,
    updateActiveTalkLLMSessionTranscript: (session) => {
      activeSession = session;
    },
    visibleToolNames: () => [],
    toolPlugins: [],
    getLLMConfig: () => ({
      client: noopClient,
      stream: false
    }),
    async sendRequest(input) {
      sentMessages.push(input.messages);
      sendCalls += 1;
      return { message: { role: "assistant", content: `reply-${sendCalls}` }, finishReason: "stop" };
    },
    appendAssistantDelta: () => {},
    finishAssistantOutput(input) {
      finishedOutputs.push(input.outputId);
    },
    log(level, message) {
      logs.push({ level, message });
    },
    async sleep() {
      sleepCalls += 1;
      pendingChars = 0;
    }
  });

  await runPreparedTalkAgentLoop(controller, "session-backpressure");

  assert.equal(sleepCalls, 1);
  assert.equal(sendCalls, 1);
  assert.equal(finishedOutputs.length, 1);
  assert.equal(sentMessages.length, 1);
  assert.equal(logs.some((entry) => entry.message.includes("talk loop waiting: voice output")), true);
});

test("talk loop prepares spec for external function-call runtime execution", async () => {
  let activeSession: any;
  const controller = createTalkAgentLoopForSession({
    isActiveTalkLLMSession: () => true,
    getActiveTalkLLMSessionId: () => "session-runtime",
    isTalkSessionOpen: () => true,
    pendingVoiceOutputCharCount: () => 0,
    isForegroundPlaybackIdle: () => true,
    getTalkPromptProfile: () => ({ ...defaultPromptProfile(), layers: [], appendLayers: [] }),
    time: createCurrentTimeProvider("UTC", () => new Date("2026-06-08T00:00:00.000Z")),
    dailyShellStore: {
      render: () => "",
      get: () => undefined
    },
    getAppearanceDescription: () => undefined,
    memoryStore: { read: () => undefined },
    diaryStore: { latestWakeBoundary: () => undefined },
    setLoopPrefixMessageCount: () => {},
    buildNextLoopMessagePatch: () => ({ replaceFrom: 0, messages: [{ role: "user", content: "hello" }] }),
    loadActiveTalkLLMSessionTranscript: () => activeSession,
    updateActiveTalkLLMSessionTranscript: (session) => {
      activeSession = session;
    },
    visibleToolNames: () => [],
    toolPlugins: [],
    getLLMConfig: () => ({
      client: noopClient,
      stream: false
    }),
    async sendRequest() {
      throw new Error("sendRequest should be called by the external runtime in this test");
    },
    appendAssistantDelta: () => {},
    finishAssistantOutput: () => {},
    log: () => {}
  });

  const prepared = await controller.prepareTalkAgentLoopForSession("session-runtime");
  assert.ok(prepared);
  const spec = await Promise.resolve(prepared.prepare ? prepared.prepare() : prepared.spec);
  assert.ok(spec && !Array.isArray(spec));
  assert.deepEqual(spec.initialMessages.at(-1), { role: "user", content: "hello" });
  const finalMessage = { role: "assistant" as const, content: "runtime talk reply" };
  prepared.complete({
    messages: [...spec.initialMessages, finalMessage],
    rounds: 1,
    finalResult: { message: finalMessage },
    finalMessage,
    stopReason: "completed",
    sentMessage: false,
    invalidateSession: false,
    toolCallCount: 0
  });
  await prepared.dispose?.();

  assert.equal(activeSession.messages.at(-1)?.content, "runtime talk reply");
});

test("talk loop stores runtime state in injected loop session holder", async () => {
  let runtimeState: unknown;
  let activeSession: any;
  const controller = createTalkAgentLoopForSession({
    isActiveTalkLLMSession: () => true,
    getActiveTalkLLMSessionId: () => "session-holder",
    isTalkSessionOpen: () => true,
    pendingVoiceOutputCharCount: () => 0,
    isForegroundPlaybackIdle: () => true,
    getTalkPromptProfile: () => ({ ...defaultPromptProfile(), layers: [], appendLayers: [] }),
    time: createCurrentTimeProvider("UTC", () => new Date("2026-06-08T00:00:00.000Z")),
    dailyShellStore: {
      render: () => "",
      get: () => undefined
    },
    getAppearanceDescription: () => undefined,
    memoryStore: { read: () => undefined },
    diaryStore: { latestWakeBoundary: () => undefined },
    setLoopPrefixMessageCount: () => {},
    buildNextLoopMessagePatch: () => ({ replaceFrom: 0, messages: [{ role: "user", content: "hello" }] }),
    loadActiveTalkLLMSessionTranscript: () => activeSession,
    updateActiveTalkLLMSessionTranscript: (session) => {
      activeSession = session;
    },
    visibleToolNames: () => [],
    toolPlugins: [],
    getLLMConfig: () => ({
      client: noopClient,
      stream: false
    }),
    async sendRequest() {
      return { message: { role: "assistant", content: "holder reply" }, finishReason: "stop" };
    },
    getLoopSessionState: () => runtimeState,
    setLoopSessionState: (state) => {
      runtimeState = state;
    },
    appendAssistantDelta: () => {},
    finishAssistantOutput: () => {},
    log: () => {}
  });

  await runPreparedTalkAgentLoop(controller, "session-holder");

  assert.equal(controller.getConversationStartIndex("session-holder"), 0);
  assert.equal(runtimeState && typeof runtimeState === "object", true);
});

test("talk loop delegates transcript preparation to injected session context runtime", async () => {
  let prepareCalls = 0;
  let activeSession: any;
  const controller = createTalkAgentLoopForSession({
    isActiveTalkLLMSession: () => true,
    getActiveTalkLLMSessionId: () => "session-context-runtime",
    isTalkSessionOpen: () => true,
    pendingVoiceOutputCharCount: () => 0,
    isForegroundPlaybackIdle: () => true,
    getTalkPromptProfile: () => ({ ...defaultPromptProfile(), layers: [], appendLayers: [] }),
    time: createCurrentTimeProvider("UTC", () => new Date("2026-06-08T00:00:00.000Z")),
    dailyShellStore: {
      render: () => "",
      get: () => undefined
    },
    getAppearanceDescription: () => undefined,
    memoryStore: { read: () => undefined },
    diaryStore: { latestWakeBoundary: () => undefined },
    setLoopPrefixMessageCount: () => {},
    buildNextLoopMessagePatch: () => {
      throw new Error("talk loop should delegate patching to injected session context runtime");
    },
    loadActiveTalkLLMSessionTranscript: () => {
      throw new Error("talk loop should delegate transcript loading to injected session context runtime");
    },
    updateActiveTalkLLMSessionTranscript: (session) => {
      activeSession = session;
    },
    async prepareSessionContext(input) {
      prepareCalls += 1;
      assert.equal(input.kind, "talk");
      assert.equal(input.sessionId, "session-context-runtime");
      activeSession = {
        messages: [{ role: "user", content: "delegated hello" }],
        staticPromptFingerprint: "talk",
        staticPromptMessageCount: 0,
        requestTimestamps: [],
        mode: "normal"
      };
      return {
        session: activeSession,
        prefixMessageCount: 0
      };
    },
    visibleToolNames: () => [],
    toolPlugins: [],
    getLLMConfig: () => ({
      client: noopClient,
      stream: false
    }),
    async sendRequest(input) {
      assert.deepEqual(input.messages.at(-1), { role: "user", content: "delegated hello" });
      return { message: { role: "assistant", content: "delegated reply" }, finishReason: "stop" };
    },
    appendAssistantDelta: () => {},
    finishAssistantOutput: () => {},
    log: () => {}
  });

  const prepared = await controller.prepareTalkAgentLoopForSession("session-context-runtime");
  assert.ok(prepared);
  const spec = await Promise.resolve(prepared.prepare ? prepared.prepare() : prepared.spec);
  assert.ok(spec && !Array.isArray(spec));
  const finalMessage = { role: "assistant" as const, content: "delegated reply" };
  prepared.complete({
    messages: [...spec.initialMessages, finalMessage],
    rounds: 1,
    finalResult: { message: finalMessage },
    finalMessage,
    stopReason: "completed",
    sentMessage: false,
    invalidateSession: false,
    toolCallCount: 0
  });
  await prepared.dispose?.();

  assert.equal(prepareCalls, 1);
  assert.equal(activeSession.messages.at(-1)?.content, "delegated reply");
});

test("talk loop waits for foreground playback idle even when voice buffer is empty", async () => {
  let foregroundIdle = false;
  let sleepCalls = 0;
  let sendCalls = 0;
  let activeSession: any;
  const logs: Array<{ level: string; message: string }> = [];
  const controller = createTalkAgentLoopForSession({
    isActiveTalkLLMSession: () => true,
    getActiveTalkLLMSessionId: () => "session-foreground-idle",
    isTalkSessionOpen: () => true,
    pendingVoiceOutputCharCount: () => 0,
    isForegroundPlaybackIdle: () => foregroundIdle,
    getTalkPromptProfile: () => ({ ...defaultPromptProfile(), layers: [], appendLayers: [] }),
    time: createCurrentTimeProvider("UTC", () => new Date("2026-06-08T00:00:00.000Z")),
    dailyShellStore: {
      render: () => "",
      get: () => undefined
    },
    getAppearanceDescription: () => undefined,
    memoryStore: { read: () => undefined },
    diaryStore: { latestWakeBoundary: () => undefined },
    setLoopPrefixMessageCount: () => {},
    buildNextLoopMessagePatch: () => ({ replaceFrom: 0, messages: [{ role: "user", content: "hello" }] }),
    loadActiveTalkLLMSessionTranscript: () => activeSession,
    updateActiveTalkLLMSessionTranscript: (session) => {
      activeSession = session;
    },
    visibleToolNames: () => [],
    toolPlugins: [],
    getLLMConfig: () => ({
      client: noopClient,
      stream: false
    }),
    async sendRequest() {
      sendCalls += 1;
      return { message: { role: "assistant", content: "reply" }, finishReason: "stop" };
    },
    appendAssistantDelta: () => {},
    finishAssistantOutput: () => {},
    log(level, message) {
      logs.push({ level, message });
    },
    async sleep() {
      sleepCalls += 1;
      foregroundIdle = true;
    }
  });

  await runPreparedTalkAgentLoop(controller, "session-foreground-idle");

  assert.equal(sleepCalls, 1);
  assert.equal(sendCalls, 1);
  assert.equal(logs.some((entry) => entry.message.includes("foreground_idle=false")), true);
});

test("talk tool-call followup runs in the same function-call loop", async () => {
  let sendCalls = 0;
  let activeSession: any;
  const sentMessages: unknown[][] = [];
  const controller = createTalkAgentLoopForSession({
    isActiveTalkLLMSession: () => true,
    getActiveTalkLLMSessionId: () => "session-tool-followup",
    isTalkSessionOpen: () => true,
    pendingVoiceOutputCharCount: () => 0,
    isForegroundPlaybackIdle: () => true,
    getTalkPromptProfile: () => ({ ...defaultPromptProfile(), layers: [], appendLayers: [] }),
    time: createCurrentTimeProvider("UTC", () => new Date("2026-06-08T00:00:00.000Z")),
    dailyShellStore: {
      render: () => "",
      get: () => undefined
    },
    getAppearanceDescription: () => undefined,
    memoryStore: { read: () => undefined },
    diaryStore: { latestWakeBoundary: () => undefined },
    setLoopPrefixMessageCount: () => {},
    buildNextLoopMessagePatch: () => ({ replaceFrom: 0, messages: [{ role: "user", content: "hello" }] }),
    loadActiveTalkLLMSessionTranscript: () => activeSession,
    updateActiveTalkLLMSessionTranscript: (session) => {
      activeSession = session;
    },
    visibleToolNames: () => ["test_tool"],
    toolPlugins: [{
      id: "test",
      listTools: () => [{
        name: "test_tool",
        description: "test",
        inputSchema: { type: "object", properties: {} }
      }],
      async execute() {
        return { callId: "call-1", ok: true, output: "tool result" };
      }
    }],
    getLLMConfig: () => ({
      client: noopClient,
      stream: false
    }),
    async sendRequest(input) {
      sentMessages.push(input.messages);
      sendCalls += 1;
      if (sendCalls === 1) {
        return {
          message: {
            role: "assistant",
            content: "",
            toolCalls: [{
              id: "call-1",
              type: "function",
              function: { name: "test_tool", arguments: "{}" }
            }]
          },
          finishReason: "tool_calls"
        };
      }
      return { message: { role: "assistant", content: "done" }, finishReason: "stop" };
    },
    appendAssistantDelta: () => {},
    finishAssistantOutput: () => {},
    log: () => {}
  });

  await runPreparedTalkAgentLoop(controller, "session-tool-followup");
  assert.equal(sendCalls, 2);
  assert.equal((sentMessages[1]?.at(-2) as { role?: string }).role, "assistant");
  assert.equal((sentMessages[1]?.at(-1) as { role?: string }).role, "tool");
});

test("talk send_chat tool-call executes through the common tool plugin path", async () => {
  let sendCalls = 0;
  let activeSession: any;
  const executedCalls: unknown[] = [];
  const sentMessages: unknown[][] = [];
  const controller = createTalkAgentLoopForSession({
    isActiveTalkLLMSession: () => true,
    getActiveTalkLLMSessionId: () => "session-send-chat-tool",
    isTalkSessionOpen: () => true,
    pendingVoiceOutputCharCount: () => 0,
    isForegroundPlaybackIdle: () => true,
    getTalkPromptProfile: () => ({ ...defaultPromptProfile(), layers: [], appendLayers: [] }),
    time: createCurrentTimeProvider("UTC", () => new Date("2026-06-08T00:00:00.000Z")),
    dailyShellStore: {
      render: () => "",
      get: () => undefined
    },
    getAppearanceDescription: () => undefined,
    memoryStore: { read: () => undefined },
    diaryStore: { latestWakeBoundary: () => undefined },
    setLoopPrefixMessageCount: () => {},
    buildNextLoopMessagePatch: () => ({ replaceFrom: 0, messages: [{ role: "user", content: "send a message" }] }),
    loadActiveTalkLLMSessionTranscript: () => activeSession,
    updateActiveTalkLLMSessionTranscript: (session) => {
      activeSession = session;
    },
    visibleToolNames: () => ["send_chat"],
    toolPlugins: [{
      id: "messaging",
      listTools: () => [{
        name: "send_chat",
        description: "send",
        inputSchema: { type: "object", properties: {} }
      }],
      async execute(call) {
        executedCalls.push(call);
        return { callId: call.id, ok: true, output: "sent" };
      }
    }],
    getLLMConfig: () => ({
      client: noopClient,
      stream: false
    }),
    async sendRequest(input) {
      sentMessages.push(input.messages);
      sendCalls += 1;
      if (sendCalls === 1) {
        return {
          message: {
            role: "assistant",
            content: "sending",
            toolCalls: [{
              id: "call-send",
              type: "function",
              function: { name: "send_chat", arguments: "{\"type\":\"message\",\"content\":\"hello\"}" }
            }]
          },
          finishReason: "tool_calls"
        };
      }
      return { message: { role: "assistant", content: "done" }, finishReason: "stop" };
    },
    appendAssistantDelta: () => {},
    finishAssistantOutput: () => {},
    log: () => {}
  });

  await runPreparedTalkAgentLoop(controller, "session-send-chat-tool");

  assert.equal(sendCalls, 2);
  assert.equal(executedCalls.length, 1);
  assert.equal((executedCalls[0] as { toolName?: string }).toolName, "send_chat");
  assert.equal((executedCalls[0] as { requester?: { plugin?: string } }).requester?.plugin, "webrtc_voice");
  assert.equal((executedCalls[0] as { session?: { sessionId?: string } }).session?.sessionId, "session-send-chat-tool");
  assert.equal((sentMessages[1]?.at(-1) as { role?: string; name?: string }).role, "tool");
  assert.equal((sentMessages[1]?.at(-1) as { role?: string; name?: string }).name, "send_chat");
});

test("talk loop reuses active session prefix and replaces runtime transcript tail", async () => {
  let promptBuildCalls = 0;
  let prefixCount: number | undefined;
  let activeSession: any = {
    messages: [
      { role: "system", content: "fixed talk prefix" },
      { role: "user", content: "old runtime input" },
      { role: "assistant", content: "old runtime output" }
    ],
    staticPromptMessageCount: 1,
    requestTimestamps: [],
    mode: "normal"
  };
  const sentMessages: unknown[][] = [];
  const controller = createTalkAgentLoopForSession({
    isActiveTalkLLMSession: () => true,
    getActiveTalkLLMSessionId: () => "session-patch",
    isTalkSessionOpen: () => true,
    pendingVoiceOutputCharCount: () => 0,
    isForegroundPlaybackIdle: () => true,
    getTalkPromptProfile: () => {
      promptBuildCalls += 1;
      return ({ ...defaultPromptProfile(), layers: [{ id: "unused", role: "system", content: "rebuilt" }], appendLayers: [] }) as any;
    },
    time: createCurrentTimeProvider("UTC", () => new Date("2026-06-08T00:00:00.000Z")),
    dailyShellStore: {
      render: () => "",
      get: () => undefined
    },
    getAppearanceDescription: () => undefined,
    memoryStore: { read: () => undefined },
    diaryStore: { latestWakeBoundary: () => undefined },
    setLoopPrefixMessageCount: (_sessionId, count) => {
      prefixCount = count;
    },
    buildNextLoopMessagePatch: () => ({
      replaceFrom: prefixCount ?? 0,
      messages: [{ role: "user", content: "new runtime input" }]
    }),
    loadActiveTalkLLMSessionTranscript: () => activeSession,
    updateActiveTalkLLMSessionTranscript: (session) => {
      activeSession = session;
    },
    visibleToolNames: () => [],
    toolPlugins: [],
    getLLMConfig: () => ({
      client: noopClient,
      stream: false
    }),
    async sendRequest(input) {
      sentMessages.push(input.messages);
      return { message: { role: "assistant", content: "new reply" }, finishReason: "stop" };
    },
    appendAssistantDelta: () => {},
    finishAssistantOutput: () => {},
    log: () => {}
  });

  await runPreparedTalkAgentLoop(controller, "session-patch");

  assert.equal(promptBuildCalls, 1);
  assert.equal(prefixCount, 1);
  assert.deepEqual(sentMessages[0], [
    { role: "system", content: "fixed talk prefix", toolCalls: undefined },
    { role: "user", content: "new runtime input", toolCalls: undefined }
  ]);
  assert.deepEqual(activeSession.messages, [
    { role: "system", content: "fixed talk prefix", toolCalls: undefined },
    { role: "user", content: "new runtime input", toolCalls: undefined },
    { role: "assistant", content: "new reply", reasoningContent: undefined }
  ]);
});

test("talk loop logs llm cancellation without error severity", async () => {
  const logs: Array<{ level: string; message: string }> = [];
  let activeSession: any;
  const controller = createTalkAgentLoopForSession({
    isActiveTalkLLMSession: () => true,
    getActiveTalkLLMSessionId: () => "session-cancel",
    isTalkSessionOpen: () => true,
    pendingVoiceOutputCharCount: () => 0,
    isForegroundPlaybackIdle: () => true,
    getTalkPromptProfile: () => ({ ...defaultPromptProfile(), layers: [], appendLayers: [] }),
    time: createCurrentTimeProvider("UTC", () => new Date("2026-06-08T00:00:00.000Z")),
    dailyShellStore: {
      render: () => "",
      get: () => undefined
    },
    getAppearanceDescription: () => undefined,
    memoryStore: { read: () => undefined },
    diaryStore: { latestWakeBoundary: () => undefined },
    setLoopPrefixMessageCount: () => {},
    buildNextLoopMessagePatch: () => ({ replaceFrom: 0, messages: [{ role: "user", content: "hello" }] }),
    loadActiveTalkLLMSessionTranscript: () => activeSession,
    updateActiveTalkLLMSessionTranscript: (session) => {
      activeSession = session;
    },
    visibleToolNames: () => [],
    toolPlugins: [],
    getLLMConfig: () => ({
      client: noopClient,
      stream: false
    }),
    async sendRequest() {
      throw new Error("llm_request_cancelled");
    },
    appendAssistantDelta: () => {},
    finishAssistantOutput: () => {},
    log(level, message) {
      logs.push({ level, message });
    }
  });

  await runPreparedTalkAgentLoop(controller, "session-cancel");

  assert.equal(logs.some((entry) => entry.level === "error"), false);
  assert.equal(logs.some((entry) => entry.level === "info" && entry.message.includes("talk loop cancelled")), true);
});

const noopClient: LLMClient = {
  async chat() {
    return { message: { role: "assistant", content: "" }, finishReason: "stop" };
  }
};
