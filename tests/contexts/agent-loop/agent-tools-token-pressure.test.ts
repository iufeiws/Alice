import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateTokenPressureSwitch, createChatAgent as createChatAgentUnderTest, type LLMSessionSnapshot } from "../../../src/contexts/agent-loop/src/application/chat-agent.js";
import type { LLMRequestSenderInput } from "../../../src/contexts/llm-gateway/src/llm-tool-loop.js";
import type { LLMChatInput, LLMClient } from "../../../src/contexts/llm-gateway/src/index.js";
import type { AgentEvent, ToolCall } from "../../../src/contexts/agent-loop/src/contracts/agent-contracts.js";
import { loadConfig } from "../../../src/apps/api/bootstrap/app-config-runtime.js";
import { createOutputRouter } from "../../../src/platform/output-router/src/index.js";
import { createAllowAllPolicy } from "../../../src/contexts/agent-loop/src/ports/policy.js";
import { createIntentRouter } from "../../../src/contexts/agent-loop/src/application/intent-router.js";
import { createSessionResolver } from "../../../src/contexts/agent-loop/src/application/session-resolver.js";
import { createAgentStateController, type AgentBehaviorState } from "../../../src/contexts/agent-loop/src/domain/agent-loop-state.js";
import { createChatAgent, runPreparedChatEvent, textEvent, chatTestTools, memoryStore, messageContentText } from "./agent-tools-helpers.js";
import { testPromptRuntime } from "../../helpers/prompt-runtime.js";

test("chat agent restores token pressure baseline from persisted session snapshot", async () => {
  const requests: LLMChatInput[] = [];
  const events: string[] = [];
  const previewCalls: Array<Record<string, unknown>> = [];
  let persistedSession: LLMSessionSnapshot | undefined;
  const llm: LLMClient = {
    async chat(input) {
      requests.push(input);
      return {
        message: { role: "assistant", content: `final ${requests.length}` },
        model: "deepseek-v4-flash",
        usage: { inputTokens: 3001, totalTokens: 3001 }
      };
    }
  };
  const baseDeps = {
    config: loadConfig({ LLM_MODEL: "deepseek-v4-flash", LLM_TOKEN_PRESSURE_CONTEXT_IMPORTANCE: "1" }),
    llm,
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy(),
    getPromptProfile: () => ({
      userName: "user",
      visibleTools: { feishu: true },
      layers: [{ id: "one", title: "One", role: "system" as const, enabled: true, content: "system", order: 1 }]
    }),
    onLLMSessionUpdated(session: LLMSessionSnapshot & { staticPromptFingerprint: string; requestTimestamps: string[] }) {
      persistedSession = {
        messages: session.messages.map((message) => ({ ...message, toolCalls: message.toolCalls?.map((call) => ({ ...call, function: { ...call.function } })) })),
        staticPromptFingerprint: session.staticPromptFingerprint,
        requestTimestamps: [...session.requestTimestamps],
        lastTotalTokens: session.lastTotalTokens,
        lastInputTokens: session.lastInputTokens,
        lastUsageModel: session.lastUsageModel,
        tokenPressurePreviewBaselines: { ...(session.tokenPressurePreviewBaselines ?? {}) }
      };
    },
    loadLLMSession() {
      return persistedSession;
    },
    onLLMSessionCleared(reason: string) {
      events.push(`cleared:${reason}`);
      persistedSession = undefined;
    },
    tools: [{
      id: "messaging-test",
      listTools() {
        return [{ name: "Chat", description: "view", inputSchema: { type: "object" } }];
      },
      async execute(call: ToolCall) {
        if (call.input.__preview === true) previewCalls.push(call.input);
        return { callId: call.id, ok: true, output: "abcdef" };
      }
    }]
  };
  const firstCore = createChatAgent(baseDeps);

  await runPreparedChatEvent(firstCore, textEvent());
  assert.ok(persistedSession);
  persistedSession = {
    ...persistedSession,
    lastInputTokens: 3001,
    lastUsageModel: "deepseek-v4-flash",
    tokenPressurePreviewBaselines: { "deepseek-v4-flash|normal|today|": { inputTokens: 1, previewTokens: 1 } }
  };

  const restartedCore = createChatAgent(baseDeps);
  await runPreparedChatEvent(restartedCore, textEvent());

  assert.deepEqual(previewCalls, [{ action: "poll", __preview: true, __scope: "today" }]);
  assert.deepEqual(events, ["cleared:token_pressure"]);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].messages.some((message) => message.content === "final 1"), false);
});

test("chat agent token pressure comparison uses model-specific prices", async () => {
  async function run(model: string): Promise<string[]> {
    const events: string[] = [];
    let persistedSession: LLMSessionSnapshot | undefined;
    const llm: LLMClient = {
      async chat() {
        return {
          message: { role: "assistant", content: "final" },
          model,
          usage: { inputTokens: 3001, totalTokens: 3001 }
        };
      }
    };
    const core = createChatAgent({
    config: loadConfig({ LLM_MODEL: model, LLM_TOKEN_PRESSURE_CONTEXT_IMPORTANCE: "1" }),
      llm,
      outputRouter: createOutputRouter(),
      intentRouter: createIntentRouter(),
      sessionResolver: createSessionResolver(),
      policy: createAllowAllPolicy(),
      getPromptProfile: () => ({
        userName: "user",
        visibleTools: { feishu: true },
        layers: [{ id: "one", title: "One", role: "system", enabled: true, content: "system", order: 1 }]
      }),
      initialLLMSession: undefined,
      loadLLMSession() {
        return persistedSession;
      },
      onLLMSessionUpdated(session) {
        persistedSession = {
          messages: session.messages.map((message) => ({ ...message, toolCalls: message.toolCalls?.map((call) => ({ ...call, function: { ...call.function } })) })),
          staticPromptFingerprint: session.staticPromptFingerprint,
          requestTimestamps: [...session.requestTimestamps],
          lastTotalTokens: 3001,
          lastInputTokens: 3001,
          lastUsageModel: model,
          tokenPressurePreviewBaselines: { [`${model}|normal|today|`]: { inputTokens: 1, previewTokens: 1 } }
        };
      },
      onLLMSessionCleared(reason) {
        events.push(reason);
        persistedSession = undefined;
      },
      tools: [{
        id: "messaging-test",
        listTools() {
          return [{ name: "Chat", description: "view", inputSchema: { type: "object" } }];
        },
        async execute(call) {
          return { callId: call.id, ok: true, output: "abcdef" };
        }
      }]
    });

    await runPreparedChatEvent(core, textEvent());
    await runPreparedChatEvent(core, textEvent());
    return events;
  }

  assert.deepEqual(await run("deepseek-v4-flash"), ["token_pressure"]);
  assert.deepEqual(await run("deepseek-v4-pro"), []);
});

test("chat agent clears only when static prompt fingerprint changes", async () => {
  const requests: LLMChatInput[] = [];
  const clears: string[] = [];
  let appendContent = "append one";
  let staticContent = "static one";
  const llm: LLMClient = {
    async chat(input) {
      requests.push(input);
      return { message: { role: "assistant", content: "ok" } };
    }
  };
  const core = createChatAgent({
    config: loadConfig({ LLM_MODEL: "test-model" }),
    llm,
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy(),
    getPromptProfile: () => ({
      userName: "user",
      visibleTools: { feishu: true },
      layers: [
        { id: "static", title: "Static", role: "system", enabled: true, content: staticContent, order: 1 }
      ],
      appendLayers: [
        { id: "append", title: "Append", role: "user", enabled: true, content: appendContent, order: 1 }
      ]
    }),
    onLLMSessionCleared(reason) {
      clears.push(reason);
    },
    tools: [{
      id: "messaging-test",
      listTools() {
        return [{ name: "Chat", description: "view", inputSchema: { type: "object" } }];
      },
      async execute(call) {
        return { callId: call.id, ok: true, output: "history" };
      }
    }]
  });

  await runPreparedChatEvent(core, textEvent());
  appendContent = "append two";
  await runPreparedChatEvent(core, textEvent());
  staticContent = "static two";
  await runPreparedChatEvent(core, textEvent());

  assert.deepEqual(clears, ["prompt_static_changed"]);
  assert.equal(requests[1].messages.some((message) => message.content === "ok"), true);
  assert.equal(requests[1].messages.some((message) => message.content === "append two"), true);
  assert.equal(requests[2].messages.some((message) => message.content === "ok"), false);
});

test("chat agent rechecks static prompt before each LLM request", async () => {
  const requests: LLMChatInput[] = [];
  const clears: string[] = [];
  const sessionUpdates: LLMChatInput["messages"][] = [];
  let dailyShellRaw = {
    date: "2026-05-29",
    createdAt: "2026-05-29T12:00:00.000",
    personality: { id: "p1", name: "P One", content: "shell one" },
    relationship: { id: "r1", name: "R One", content: "relationship one" },
    outfit: { id: "o1", name: "O One", content: "outfit one" }
  };
  const llm: LLMClient = {
    async chat(input) {
      requests.push(input);
      if (requests.length === 1) {
        return {
          message: {
            role: "assistant",
            content: "",
            toolCalls: [{
              id: "tool_wardrobe",
              type: "function",
              function: {
                name: "Wardrobe",
                arguments: "{\"action\":\"switch\",\"name\":\"O Two\"}"
              }
            }]
          }
        };
      }
      return { message: { role: "assistant", content: `ok ${requests.length}` } };
    }
  };
  const core = createChatAgent({
    config: loadConfig({ LLM_MODEL: "test-model" }),
    llm,
    outputRouter: createOutputRouter(),
    intentRouter: createIntentRouter(),
    sessionResolver: createSessionResolver(),
    policy: createAllowAllPolicy(),
    getPromptProfile: () => ({
      userName: "user",
      visibleTools: { feishu: true, shell: true },
      layers: [
        { id: "static", title: "Static", role: "system", enabled: true, content: "{{dailyShell/persona/content}}", order: 1 }
      ]
    }),
    getPromptRenderer: () => testPromptRuntime({
      user: "user",
      dailyShell: { persona: { content: dailyShellRaw.personality.content } }
    }),
    onLLMSessionCleared(reason) {
      clears.push(reason);
    },
    onLLMSessionUpdated(session) {
      sessionUpdates.push(session.messages);
    },
    tools: [{
      id: "shell",
      listTools() {
        return [{ name: "Wardrobe", description: "wardrobe", inputSchema: { type: "object" } }];
      },
      async execute(call) {
        dailyShellRaw = {
          ...dailyShellRaw,
          personality: { ...dailyShellRaw.personality, content: "shell two" }
        };
        return { callId: call.id, ok: true, output: "switched" };
      }
    }]
  });

  await runPreparedChatEvent(core, textEvent());

  assert.deepEqual(clears, ["prompt_static_changed"]);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].messages.some((message) => message.content === "shell one"), true);
  assert.equal(requests[1].messages.some((message) => message.content === "shell two"), true);
  assert.equal(requests[1].messages.some((message) => message.content === "switched"), false);
  assert.equal(sessionUpdates.some((messages) => messages.some((message) => message.role === "tool" && message.content === "switched")), true);
  assert.equal(sessionUpdates.at(-1)?.some((message) => message.content === "switched"), false);
});
