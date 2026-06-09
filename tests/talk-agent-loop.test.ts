import { test } from "node:test";
import assert from "node:assert/strict";
import { createTalkAgentLoopForSession } from "../src/contexts/agent-loop/src/application/run-talk-loop.js";
import { defaultTalkOutputReadyChars } from "../src/contexts/talk-session/src/application/talk-session-runtime.js";
import { defaultPromptProfile } from "../src/contexts/agent-profile/src/application/build-system-prompt.js";
import { createCurrentTimeProvider } from "../src/platform/time/src/index.js";
import type { LLMClient } from "../src/contexts/llm-gateway/src/index.js";

test("talk loop waits for voice output backpressure instead of exiting", async () => {
  let pendingChars = defaultTalkOutputReadyChars;
  let sleepCalls = 0;
  let sendCalls = 0;
  let maxRoundEvent: { sessionId: string; rounds: number } | undefined;
  const sentMessages: unknown[][] = [];
  const finishedOutputs: string[] = [];
  const logs: Array<{ level: string; message: string }> = [];
  const controller = createTalkAgentLoopForSession({
    isActiveTalkLLMSession: () => true,
    getActiveTalkLLMSessionId: () => "session-backpressure",
    isTalkSessionOpen: () => true,
    pendingVoiceOutputCharCount: () => pendingChars,
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
      maxContinuousRounds: 2,
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
    onMaxContinuousRounds(input) {
      maxRoundEvent = input;
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
  assert.equal(sendCalls, 2);
  assert.equal(finishedOutputs.length, 2);
  assert.equal("toolCalls" in (sentMessages[1]?.at(-1) as Record<string, unknown>), false);
  assert.deepEqual(maxRoundEvent, { sessionId: "session-backpressure", rounds: 2 });
  assert.equal(logs.some((entry) => entry.message.includes("talk loop waiting: voice output buffer")), true);
});

test("talk loop logs llm cancellation without error severity", async () => {
  const logs: Array<{ level: string; message: string }> = [];
  const controller = createTalkAgentLoopForSession({
    isActiveTalkLLMSession: () => true,
    getActiveTalkLLMSessionId: () => "session-cancel",
    isTalkSessionOpen: () => true,
    pendingVoiceOutputCharCount: () => 0,
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
      maxContinuousRounds: 1,
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
