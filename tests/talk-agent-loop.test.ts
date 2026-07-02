import { test } from "node:test";
import assert from "node:assert/strict";
import { createTalkAgentLoopForSession } from "../src/contexts/agent-loop/src/application/run-talk-loop.js";
import { runAgentFunctionCallLoop } from "../src/contexts/agent-loop/src/runtime/agent-loop-runtime.js";
import { defaultTalkOutputReadyChars } from "../src/contexts/talk-session/src/application/talk-session-runtime.js";
import { defaultPromptProfile } from "../src/contexts/agent-profile/src/application/build-system-prompt.js";
import { createCurrentTimeProvider } from "../src/platform/time/src/index.js";
import type { LLMClient } from "../src/contexts/llm-gateway/src/index.js";

async function runPreparedTalkAgentLoop(controller: ReturnType<typeof createTalkAgentLoopForSession>, sessionId: number): Promise<void> {
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

test("talk loop returns no prepared run while voice output backpressure is active", async () => {
  let pendingChars = defaultTalkOutputReadyChars;
  let sendCalls = 0;
  let activeSession: any;
  const sentMessages: unknown[][] = [];
  const finishedOutputs: string[] = [];
  const logs: Array<{ level: string; message: string }> = [];
  const controller = createTalkAgentLoopForSession({
    isActiveTalkLLMSession: () => true,
    getCurrentTalkLLMSessionId: () => 101,
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
    }
  });

  let prepared = await controller.prepareTalkAgentLoopForSession(101);
  assert.equal(prepared, undefined);
  assert.equal(sendCalls, 0);
  assert.equal(finishedOutputs.length, 0);
  assert.equal(sentMessages.length, 0);
  assert.equal(logs.some((entry) => entry.message.includes("talk loop not ready: voice output")), true);

  pendingChars = 0;
  prepared = await controller.prepareTalkAgentLoopForSession(101);
  assert.ok(prepared);
  const spec = await Promise.resolve(prepared.prepare ? prepared.prepare() : prepared.spec);
  assert.ok(spec && !Array.isArray(spec));
  prepared.complete(await runAgentFunctionCallLoop(spec));
  await prepared.dispose?.();

  assert.equal(sendCalls, 1);
  assert.equal(finishedOutputs.length, 1);
  assert.equal(sentMessages.length, 1);
});

test("talk loop prepares spec for external function-call runtime execution", async () => {
  let activeSession: any;
  const controller = createTalkAgentLoopForSession({
    isActiveTalkLLMSession: () => true,
    getCurrentTalkLLMSessionId: () => 102,
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

  const abortController = new AbortController();
  const prepared = await controller.prepareTalkAgentLoopForSession(102, { signal: abortController.signal });
  assert.ok(prepared);
  const spec = await Promise.resolve(prepared.prepare ? prepared.prepare() : prepared.spec);
  assert.ok(spec && !Array.isArray(spec));
  assert.deepEqual(spec.initialMessages.at(-1), { role: "user", content: "hello" });
  const request = await Promise.resolve(spec.buildRequest({ round: 0, messages: spec.initialMessages }));
  assert.equal(request.signal, abortController.signal);
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

test("talk loop delegates transcript preparation to injected session context runtime", async () => {
  let prepareCalls = 0;
  let activeSession: any;
  const controller = createTalkAgentLoopForSession({
    isActiveTalkLLMSession: () => true,
    getCurrentTalkLLMSessionId: () => 104,
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
      assert.equal(input.sessionId, "104");
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

  const prepared = await controller.prepareTalkAgentLoopForSession(104);
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

test("talk loop returns no prepared run until foreground playback is idle", async () => {
  let foregroundIdle = false;
  let sendCalls = 0;
  let activeSession: any;
  const logs: Array<{ level: string; message: string }> = [];
  const controller = createTalkAgentLoopForSession({
    isActiveTalkLLMSession: () => true,
    getCurrentTalkLLMSessionId: () => 105,
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
    }
  });

  let prepared = await controller.prepareTalkAgentLoopForSession(105);
  assert.equal(prepared, undefined);
  assert.equal(sendCalls, 0);
  assert.equal(logs.some((entry) => entry.message.includes("foreground_idle=false")), true);

  foregroundIdle = true;
  prepared = await controller.prepareTalkAgentLoopForSession(105);
  assert.ok(prepared);
  const spec = await Promise.resolve(prepared.prepare ? prepared.prepare() : prepared.spec);
  assert.ok(spec && !Array.isArray(spec));
  prepared.complete(await runAgentFunctionCallLoop(spec));
  await prepared.dispose?.();

  assert.equal(sendCalls, 1);
});

test("talk tool-call followup runs in the same function-call loop", async () => {
  let sendCalls = 0;
  let activeSession: any;
  const sentMessages: unknown[][] = [];
  const controller = createTalkAgentLoopForSession({
    isActiveTalkLLMSession: () => true,
    getCurrentTalkLLMSessionId: () => 106,
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
              function: { name: "test_tool", arguments: "{\"action\":\"poll\"}" }
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

  await runPreparedTalkAgentLoop(controller, 106);
  assert.equal(sendCalls, 2);
  assert.equal((sentMessages[1]?.at(-2) as { role?: string }).role, "assistant");
  assert.equal((sentMessages[1]?.at(-1) as { role?: string }).role, "tool");
});

test("talk Chat tool-call executes through the common tool plugin path", async () => {
  let sendCalls = 0;
  let activeSession: any;
  const executedCalls: unknown[] = [];
  const sentMessages: unknown[][] = [];
  const controller = createTalkAgentLoopForSession({
    isActiveTalkLLMSession: () => true,
    getCurrentTalkLLMSessionId: () => 107,
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
    visibleToolNames: () => ["Chat"],
    toolPlugins: [{
      id: "messaging",
      listTools: () => [{
        name: "Chat",
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
              function: { name: "Chat", arguments: "{\"action\":\"send\",\"type\":\"message\",\"content\":\"hello\"}" }
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

  await runPreparedTalkAgentLoop(controller, 107);

  assert.equal(sendCalls, 2);
  assert.equal(executedCalls.length, 1);
  assert.equal((executedCalls[0] as { toolName?: string }).toolName, "Chat");
  assert.equal((executedCalls[0] as { requester?: { plugin?: string } }).requester?.plugin, "webrtc_voice");
  assert.equal((executedCalls[0] as { externalSession?: { sessionId?: string } }).externalSession?.sessionId, "107");
  assert.equal((sentMessages[1]?.at(-1) as { role?: string; name?: string }).role, "tool");
  assert.equal((sentMessages[1]?.at(-1) as { role?: string; name?: string }).name, "Chat");
});

test("talk exposed selfie tool calls receive agent loop run context", async () => {
  let sendCalls = 0;
  let activeSession: any;
  const executedPoses: string[] = [];
  const observedContexts: Array<{ agentLoopRunSeq?: number; llmSessionId?: number }> = [];
  const sentMessages: unknown[][] = [];
  const controller = createTalkAgentLoopForSession({
    isActiveTalkLLMSession: () => true,
    getCurrentTalkLLMSessionId: () => 108,
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
    buildNextLoopMessagePatch: () => ({ replaceFrom: 0, messages: [{ role: "user", content: "take selfies" }] }),
    loadActiveTalkLLMSessionTranscript: () => activeSession,
    updateActiveTalkLLMSessionTranscript: (session) => {
      activeSession = session;
    },
    visibleToolNames: () => ["selfie"],
    toolPlugins: [{
      id: "photo",
      listTools: () => [{
        name: "selfie",
        description: "selfie",
        inputSchema: { type: "object", properties: {} }
      }],
      async execute(call, context) {
        executedPoses.push(String(call.input.pose));
        observedContexts.push({ agentLoopRunSeq: context?.agentLoopRunSeq, llmSessionId: context?.llmSessionId });
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
            content: "",
            toolCalls: [{
              id: "call-selfie-1",
              type: "function",
              function: { name: "selfie", arguments: "{\"pose\":\"first\"}" }
            }, {
              id: "call-selfie-2",
              type: "function",
              function: { name: "selfie", arguments: "{\"pose\":\"second\"}" }
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

  await runPreparedTalkAgentLoop(controller, 108);

  assert.equal(sendCalls, 2);
  assert.deepEqual(executedPoses, ["first", "second"]);
  assert.deepEqual(observedContexts, [
    { agentLoopRunSeq: 1, llmSessionId: 108 },
    { agentLoopRunSeq: 1, llmSessionId: 108 }
  ]);
  assert.equal((sentMessages[1]?.at(-2) as { content?: string }).content, "sent");
  assert.equal((sentMessages[1]?.at(-1) as { content?: string }).content, "sent");
  assert.equal(activeSession.lastCompletedToolName, "selfie");
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
    getCurrentTalkLLMSessionId: () => 109,
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

  await runPreparedTalkAgentLoop(controller, 109);

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
    getCurrentTalkLLMSessionId: () => 110,
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

  await runPreparedTalkAgentLoop(controller, 110);

  assert.equal(logs.some((entry) => entry.level === "error"), false);
  assert.equal(logs.some((entry) => entry.level === "info" && entry.message.includes("talk loop cancelled")), true);
});

const noopClient: LLMClient = {
  async chat() {
    return { message: { role: "assistant", content: "" }, finishReason: "stop" };
  }
};
