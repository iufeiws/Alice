import { test } from "node:test";
import assert from "node:assert/strict";
import { createTalkAgentLoopForSession } from "../../../src/contexts/agent-loop/src/application/run-talk-loop.js";
import { defaultPromptProfile } from "../../../src/contexts/agent-profile/src/application/build-system-prompt.js";
import { createCurrentTimeProvider } from "../../../src/platform/time/src/index.js";
import { registerLLMToolLoopTools } from "../../../src/contexts/llm-gateway/src/llm-tool-loop.js";
import type { ToolPlugin } from "../../../src/contexts/agent-loop/src/contracts/agent-contracts.js";
import { noopClient, runPreparedTalkAgentLoop, testPromptRenderer } from "./talk-agent-loop-helpers.js";

test("talk exposed selfie tool calls receive agent loop run context", async () => {
  let sendCalls = 0;
  let activeSession: any;
  const executedPoses: string[] = [];
  const observedContexts: Array<{ agentLoopRunSeq?: number; llmSessionId?: number }> = [];
  const sentMessages: unknown[][] = [];
  const tools: ToolPlugin[] = [{
    id: "photo",
    listTools: () => [{
      name: "Selfie",
      description: "selfie",
      inputSchema: { type: "object", properties: {} }
    }],
    async execute(call, context) {
      executedPoses.push(String(call.input.pose));
      observedContexts.push({ agentLoopRunSeq: context?.agentLoopRunSeq, llmSessionId: context?.llmSessionId });
      return { callId: call.id, ok: true, output: "sent" };
    }
  }];
  registerLLMToolLoopTools("default", tools);
  const controller = createTalkAgentLoopForSession({
    isActiveTalkLLMSession: () => true,
    getCurrentTalkLLMSessionId: () => 108,
    isTalkSessionOpen: () => true,
    pendingVoiceOutputCharCount: () => 0,
    isForegroundPlaybackIdle: () => true,
    getTalkPromptProfile: () => ({ ...defaultPromptProfile(), layers: [], appendLayers: [] }),
    getPromptRenderer: testPromptRenderer,
    time: createCurrentTimeProvider("UTC", () => new Date("2026-06-08T00:00:00.000Z")),
    setLoopPrefixMessageCount: () => {},
    buildNextLoopMessagePatch: () => ({ replaceFrom: 0, messages: [{ role: "user", content: "take selfies" }] }),
    loadActiveTalkLLMSessionTranscript: () => activeSession,
    updateActiveTalkLLMSessionTranscript: (session) => {
      activeSession = session;
    },
    visibleToolNames: () => ["Selfie"],
    toolPlugins: tools,
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
              function: { name: "Selfie", arguments: "{\"pose\":\"first\"}" }
            }, {
              id: "call-selfie-2",
              type: "function",
              function: { name: "Selfie", arguments: "{\"pose\":\"second\"}" }
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
});

test("talk loop reuses active session prefix and replaces runtime transcript tail", async () => {
  let prefixCount: number | undefined;
  let activeSession: any = {
    messages: [
      { role: "system", content: "" },
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
    getTalkPromptProfile: () => ({ ...defaultPromptProfile(), layers: [], appendLayers: [] }),
    getPromptRenderer: testPromptRenderer,
    time: createCurrentTimeProvider("UTC", () => new Date("2026-06-08T00:00:00.000Z")),
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

  const requestRoles = sentMessages[0]?.map((message) => (message as { role?: string }).role);
  const transcriptContents = activeSession.messages.map((message: { content?: string }) => message.content);
  assert.equal(prefixCount, 1);
  assert.deepEqual(requestRoles, ["system", "user"]);
  assert.equal((sentMessages[0]?.at(-1) as { content?: string }).content, "new runtime input");
  assert.equal(activeSession.messages.at(-1)?.content, "new reply");
  assert.equal(transcriptContents.includes("old runtime input"), false);
  assert.equal(transcriptContents.includes("old runtime output"), false);
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
    getPromptRenderer: testPromptRenderer,
    time: createCurrentTimeProvider("UTC", () => new Date("2026-06-08T00:00:00.000Z")),
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
