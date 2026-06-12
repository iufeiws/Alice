import { test } from "node:test";
import assert from "node:assert/strict";
import { createTalkAgentLoopForSession } from "../src/contexts/agent-loop/src/application/run-talk-loop.js";
import { defaultTalkOutputReadyChars } from "../src/contexts/talk-session/src/application/talk-session-runtime.js";
import { defaultPromptProfile } from "../src/contexts/agent-profile/src/application/build-system-prompt.js";
import { createCurrentTimeProvider } from "../src/platform/time/src/index.js";
import type { LLMClient } from "../src/contexts/llm-gateway/src/index.js";

test("talk loop waits for voice output backpressure and runs one LLM round per launch", async () => {
  let pendingChars = defaultTalkOutputReadyChars;
  let sleepCalls = 0;
  let sendCalls = 0;
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
    buildNextLoopMessages: () => [{ role: "user", content: "hello" }],
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

  await controller.runTalkAgentLoopForSession("session-backpressure");

  assert.equal(sleepCalls, 1);
  assert.equal(sendCalls, 1);
  assert.equal(finishedOutputs.length, 1);
  assert.equal(sentMessages.length, 1);
  assert.equal(logs.some((entry) => entry.message.includes("talk loop waiting: voice output")), true);
});

test("talk loop waits for foreground playback idle even when voice buffer is empty", async () => {
  let foregroundIdle = false;
  let sleepCalls = 0;
  let sendCalls = 0;
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
    buildNextLoopMessages: () => [{ role: "user", content: "hello" }],
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

  await controller.runTalkAgentLoopForSession("session-foreground-idle");

  assert.equal(sleepCalls, 1);
  assert.equal(sendCalls, 1);
  assert.equal(logs.some((entry) => entry.message.includes("foreground_idle=false")), true);
});

test("talk tool-call followup runs in the same function-call loop", async () => {
  let sendCalls = 0;
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
    buildNextLoopMessages: () => [{ role: "user", content: "hello" }],
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

  await controller.runTalkAgentLoopForSession("session-tool-followup");
  assert.equal(sendCalls, 2);
  assert.equal((sentMessages[1]?.at(-2) as { role?: string }).role, "assistant");
  assert.equal((sentMessages[1]?.at(-1) as { role?: string }).role, "tool");
});

test("talk send_chat tool-call executes through the common tool plugin path", async () => {
  let sendCalls = 0;
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
    buildNextLoopMessages: () => [{ role: "user", content: "send a message" }],
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

  await controller.runTalkAgentLoopForSession("session-send-chat-tool");

  assert.equal(sendCalls, 2);
  assert.equal(executedCalls.length, 1);
  assert.equal((executedCalls[0] as { toolName?: string }).toolName, "send_chat");
  assert.equal((executedCalls[0] as { requester?: { plugin?: string } }).requester?.plugin, "webrtc_voice");
  assert.equal((executedCalls[0] as { session?: { sessionId?: string } }).session?.sessionId, "session-send-chat-tool");
  assert.equal((sentMessages[1]?.at(-1) as { role?: string; name?: string }).role, "tool");
  assert.equal((sentMessages[1]?.at(-1) as { role?: string; name?: string }).name, "send_chat");
});

test("talk loop logs llm cancellation without error severity", async () => {
  const logs: Array<{ level: string; message: string }> = [];
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
    buildNextLoopMessages: () => [{ role: "user", content: "hello" }],
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

  await controller.runTalkAgentLoopForSession("session-cancel");

  assert.equal(logs.some((entry) => entry.level === "error"), false);
  assert.equal(logs.some((entry) => entry.level === "info" && entry.message.includes("talk loop cancelled")), true);
});

const noopClient: LLMClient = {
  async chat() {
    return { message: { role: "assistant", content: "" }, finishReason: "stop" };
  }
};
