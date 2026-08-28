import { test } from "node:test";
import assert from "node:assert/strict";
import { createLLMRequestsRuntime } from "../../../src/contexts/llm-gateway/src/llm-requests-runtime.js";
import { createLLMLogRuntime } from "../../../src/contexts/llm-gateway/src/llm-log-runtime.js";
import { createLLMRequestPreviewRuntime } from "../../../src/contexts/llm-gateway/src/llm-request-preview-runtime.js";
import { runLLMToolLoop } from "../../../src/contexts/llm-gateway/src/llm-tool-loop.js";
import { createTokenUsageRuntime } from "../../../src/contexts/llm-gateway/src/token-usage-runtime.js";
import { createApiSessionRuntime } from "../../../src/contexts/llm-session/src/index.js";
import type { SessionClearRequest } from "../../../src/contexts/llm-session/src/application/session-clear-coordinator.js";
import { createLLMSessionStore } from "../../../src/contexts/llm-session/src/adapters/sqlite-llm-session-store.js";
import { createLLMSessionFilePath, writeLLMSessionJsonl, readLLMSessionJsonl } from "../../../src/contexts/llm-session/src/adapters/jsonl-llm-session-log.js";
import type { LLMClient } from "../../../src/contexts/llm-gateway/src/index.js";
import { fs, path, fixedTime, makeTempDir } from "./llm-and-storage-helpers.js";

test("LLM session files use type and UTC creation time in path", () => {
  const root = makeTempDir("llm-session-path");
  const filePath = createLLMSessionFilePath(root, "2026-06-03T14:19:01.271+08:00", { type: "chat" });
  assert.equal(path.relative(root, filePath), path.join("chat", "2026-06-03", "06-19-01-271.jsonl"));
});

test("LLM session jsonl preserves metadata", () => {
  const root = makeTempDir("llm-session-metadata");
  const filePath = createLLMSessionFilePath(root, "2026-06-03T14:19:01.271+08:00", { type: "chat" });
  writeLLMSessionJsonl(filePath, {
    type: "llm_session",
    schemaVersion: 1,
    sessionId: Date.parse("2026-06-03T06:19:01.271Z"),
    sessionCreatedAtUtc: "2026-06-03T06:19:01.271Z"
  }, [{ role: "user", content: "hello" }]);
  const parsed = readLLMSessionJsonl(filePath);
  assert.equal(parsed?.metadata.sessionId, Date.parse("2026-06-03T06:19:01.271Z"));
  assert.equal(parsed?.metadata.sessionCreatedAtUtc, "2026-06-03T06:19:01.271Z");
});

test("LLM session jsonl preserves transcript messages", () => {
  const root = makeTempDir("llm-session-transcript");
  const filePath = createLLMSessionFilePath(root, "2026-06-03T14:19:01.271+08:00", { type: "chat" });
  writeLLMSessionJsonl(filePath, {
    type: "llm_session",
    schemaVersion: 1,
    sessionId: Date.parse("2026-06-03T06:19:01.271Z"),
    sessionCreatedAtUtc: "2026-06-03T06:19:01.271Z"
  }, [{ role: "user", content: "hello" }]);
  const parsed = readLLMSessionJsonl(filePath);
  assert.equal(parsed?.messages[0].content, "hello");
});

test("LLM log runtime binds responses to the request session instead of current active session", () => {
  const requestLogs: any[] = [];
  const responseLogs: any[] = [];
  let activeSession: { id: number; requestIds: number[] } | undefined;
  const logRuntime = createLLMLogRuntime({
    time: fixedTime("2026-06-14T01:00:00.000Z"),
    requestLogs,
    responseLogs,
    ensureActiveSession(_time, agentId = "chat") {
      activeSession = { id: agentId === "talk" ? 200 : 100, requestIds: [] };
      return activeSession;
    },
    getActiveSession() {
      return activeSession;
    },
    noteRequest(entry) {
      activeSession?.requestIds.push(entry.id);
    },
    noteResponse() {},
    resolveModel: () => "model",
  });

  const requestMessages = [{ role: "user" as const, content: "hello" }];
  const request = logRuntime.appendRequestLog({
    messages: requestMessages,
    model: "chat-model",
    presetName: "chat-flash",
    extraParams: { tool_choice: { type: "function", function: { name: "Chat" } } }
  }, "chat", requestMessages);
  activeSession = { id: 200, requestIds: [99] };

  const response = logRuntime.appendResponseLog({
    message: { role: "assistant", content: "done" },
    finishReason: "stop"
  }, "chat", request);

  assert.equal(request.sessionId, 100);
  assert.equal(request.presetName, "chat-flash");
  assert.equal(response.sessionId, 100);
  assert.equal(response.requestId, request.id);
  assert.equal(responseLogs[0].sessionId, 100);
  assert.equal(Object.prototype.hasOwnProperty.call(requestLogs[0], "messages"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(requestLogs[0], "rawRequest"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(responseLogs[0], "message"), false);
});

test("LLM session runtime writes chat request directly to sqlite", () => {
  const { runtime, readCurrentSession } = createChatSessionRuntime("llm-session-request-sqlite");
  const request = chatRequest(1, [
    { role: "system" as const, content: "system" },
    { role: "user" as const, content: "hello" }
  ]);
  runtime.noteLLMRequest(request, "chat", request.messages);

  const { pointer, session } = readCurrentSession();
  assert.deepEqual(Object.keys(pointer).sort(), ["agentType", "sessionId"], "pointer must contain only sessionId and agentType");
  assert.equal(pointer.agentType, "chat");
  assert.equal(session?.agentType, "chat");
  assert.deepEqual(session?.messages.map((message: any) => message.role), ["system", "user"]);
  assert.deepEqual(session?.meta.requestIds, [1]);
});

test("LLM session runtime appends chat response directly to sqlite", () => {
  const { runtime, readCurrentSession } = createChatSessionRuntime("llm-session-response-sqlite");
  const request = chatRequest(1, [
    { role: "system" as const, content: "system" },
    { role: "user" as const, content: "hello" }
  ]);
  runtime.noteLLMRequest(request, "chat", request.messages);

  runtime.noteLLMResponse({
    id: 2,
    agentId: "chat",
    sessionId: request.sessionId,
    requestId: 1,
    time: "2026-06-14T01:00:01.000",
    timeUtc: "2026-06-14T01:00:01.000Z",
    message: { role: "assistant", content: "done" },
    finishReason: "stop"
  });
  const { pointer, session } = readCurrentSession();
  assert.equal(pointer.agentType, "chat");
  assert.deepEqual(session?.messages.map((message: any) => message.role), ["system", "user", "assistant"]);
  assert.deepEqual(session?.meta.responseIds, [2]);
});

test("LLM session runtime records latest chat request metadata", () => {
  const { runtime, readCurrentSession } = createChatSessionRuntime("llm-session-latest-request");
  const request = chatRequest(1, [
    { role: "system" as const, content: "system" },
    { role: "user" as const, content: "hello" }
  ]);
  runtime.noteLLMRequest(request, "chat", request.messages);
  runtime.noteLLMResponse({
    id: 2,
    agentId: "chat",
    sessionId: request.sessionId,
    requestId: 1,
    time: "2026-06-14T01:00:01.000",
    timeUtc: "2026-06-14T01:00:01.000Z",
    message: { role: "assistant", content: "done" },
    finishReason: "stop"
  });

  const nextMessages = [
    { role: "system" as const, content: "system" },
    { role: "user" as const, content: "hello" },
    { role: "assistant" as const, content: "done" },
    { role: "user" as const, content: "again" }
  ];
  runtime.noteLLMRequest({
    id: 3,
    agentId: "chat",
    time: "2026-06-14T01:00:02.000",
    timeUtc: "2026-06-14T01:00:02.000Z",
    model: "chat-model",
    messageCount: nextMessages.length
  }, "chat", nextMessages);
  const { session } = readCurrentSession();
  assert.equal((session?.meta.latestRequestInfo as any)?.round, 1);
  assert.deepEqual(session?.meta.requestIds, [1, 3]);
});

test("LLM requests runtime passes request-scoped log entry to response logging", async () => {
  const responseRequestIds: Array<number | undefined> = [];
  let nextRequestId = 10;
  const client: LLMClient = {
    async chat() {
      return { message: { role: "assistant", content: "done" }, finishReason: "stop" };
    }
  };
  const runtime = createLLMRequestsRuntime({
    getTool() {
      return undefined;
    },
    appendLLMRequestLog(request) {
      return {
        id: nextRequestId++,
        agentId: "chat",
        sessionId: 123,
        time: "2026-06-14T01:00:00.000",
        messageCount: request.messages.length,
        presetName: request.presetName
      };
    },
    appendLLMResponseLog(_result, _agentId, request) {
      responseRequestIds.push(request?.id);
    },
    appendLLMUsageLog() {},
    time: fixedTime("2026-06-14T01:00:00.000Z"),
    resolvePromptApiPreset: () => ({ model: "fallback" }),
    appendLog() {}
  });

  await runtime.send({
    agentId: "chat",
    client,
    messages: [{ role: "user", content: "hello" }],
    model: "chat-model",
    presetName: "chat-flash",
    toolNames: [],
    round: 0
  });

  assert.deepEqual(responseRequestIds, [10]);
});

test("gateway sanitization does not replace the authoritative session transcript", async () => {
  const { runtime: sessionRuntime, readCurrentSession } = createChatSessionRuntime("llm-request-transcript-separation");
  const requestLogs: any[] = [];
  const responseLogs: any[] = [];
  const transportMessages: any[][] = [];
  const logRuntime = createLLMLogRuntime({
    time: fixedTime("2026-06-14T01:00:00.000Z"),
    requestLogs,
    responseLogs,
    ensureActiveSession: (time, agentId) => sessionRuntime.ensureCurrentLLMSession(time, agentId),
    getActiveSession: () => sessionRuntime.getCurrentLLMSessionSnapshot() as any,
    noteRequest: (entry, agentId, transcript) => sessionRuntime.noteLLMRequest(entry, agentId, transcript),
    noteResponse: (entry) => sessionRuntime.noteLLMResponse(entry),
    resolveModel: () => "chat-model",
  });
  let requestCount = 0;
  const client: LLMClient = {
    async chat(input) {
      transportMessages.push(input.messages as any[]);
      requestCount += 1;
      return requestCount === 1
        ? {
          message: {
            role: "assistant",
            content: "",
            reasoningContent: "private reasoning",
            toolCalls: []
          },
          finishReason: "stop"
        }
        : { message: { role: "assistant", content: "done" }, finishReason: "stop" };
    }
  };
  const requests = createLLMRequestsRuntime({
    getTool: () => undefined,
    appendLLMRequestLog: (request, agentId, transcript) => logRuntime.appendRequestLog(request, agentId, transcript),
    appendLLMResponseLog: (result, agentId, request) => logRuntime.appendResponseLog(result, agentId, request),
    appendLLMUsageLog() {},
    time: fixedTime("2026-06-14T01:00:00.000Z"),
    resolvePromptApiPreset: () => ({ model: "chat-model" }),
    appendLog() {}
  });

  await requests.send({
    agentId: "chat",
    client,
    messages: [{ role: "user", content: "start" }],
    toolNames: [],
    round: 0
  });
  const transcript = sessionRuntime.loadCurrentLLMSessionTranscript() as any;
  await requests.send({
    agentId: "chat",
    client,
    messages: [...transcript.messages, { role: "user", content: "again" }],
    toolNames: [],
    round: 1
  });

  assert.deepEqual(transportMessages[1][1], { role: "assistant", content: "" }, "upstream receives the sanitized assistant message");
  assert.equal(Object.prototype.hasOwnProperty.call(requestLogs[1], "messages"), false, "request log must not duplicate session messages");
  assert.equal(Object.prototype.hasOwnProperty.call(requestLogs[1], "rawRequest"), false, "request log must not duplicate messages through rawRequest");
  const persisted = readCurrentSession().session;
  assert.deepEqual(persisted?.messages.slice(0, 3), [
    { role: "user", content: "start" },
    { role: "assistant", content: "", reasoningContent: "private reasoning", toolCalls: [] },
    { role: "user", content: "again" }
  ], "session transcript retains the unsanitized history used by the loop");
});

test("LLM request preview materializes messages from the active session", () => {
  const requestLogs = [{
    id: 7,
    agentId: "chat" as const,
    sessionId: 100,
    time: "2026-06-14T01:00:00.000",
    model: "chat-model",
    messageCount: 2
  }];
  const sessionMessages = [
    { role: "system" as const, content: "system" },
    { role: "user" as const, content: "hello" },
    { role: "assistant" as const, content: "not part of the request" }
  ];
  const runtime = createLLMRequestPreviewRuntime({
    requestLogs,
    getActiveSession: () => ({ id: 100, messages: sessionMessages }),
    listRecentMessages: () => [],
    getPromptProfile: () => ({}),
    getTalkPromptProfile: () => ({}),
    getDefaultTarget: () => undefined,
    resolveChatPreset: () => undefined,
    time: fixedTime("2026-06-14T01:00:00.000Z"),
    buildPromptPreviewMessages: async () => [],
    visibleToolSpecs: () => []
  });

  const preview = runtime.getLatestActualLLMRequestPreview();
  assert.deepEqual(preview?.messages.map((message) => ({ role: message.role, content: message.content })), sessionMessages.slice(0, 2));
  assert.deepEqual((preview?.rawRequest as any)?.messages.map((message: any) => ({ role: message.role, content: message.content })), sessionMessages.slice(0, 2));
  assert.equal(Object.prototype.hasOwnProperty.call(requestLogs[0], "messages"), false);
});

test("LLM requests runtime records deferred chat and talk responses after tool-loop formatting", async () => {
  const responseRequestIds: Array<number | undefined> = [];
  const responseResults: unknown[] = [];
  const client: LLMClient = {
    async chat() {
      return {
        model: "chat-model",
        message: { role: "assistant", content: "done" },
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 }
      };
    }
  };
  for (const agentId of ["chat", "talk"] as const) {
    const runtime = createLLMRequestsRuntime({
      getTool: () => undefined,
      appendLLMRequestLog() {
        return {
          id: 10,
          agentId,
          sessionId: 123,
          time: "2026-06-14T01:00:00.000",
          messageCount: 0
        };
      },
      appendLLMResponseLog(result, _agentId, request) {
        responseRequestIds.push(request?.id);
        responseResults.push(result);
      },
      appendLLMUsageLog() {},
      time: fixedTime("2026-06-14T01:00:00.000Z"),
      resolvePromptApiPreset: () => ({ model: "fallback" }),
      appendLog() {}
    });

    const result = await runLLMToolLoop({
      initialMessages: [{ role: "user", content: "hello" }],
      buildRequest({ messages }) {
        return {
          agentId,
          client,
          messages,
          model: "chat-model",
          toolNames: []
        };
      },
      // 模拟 agent-run indicator 包装器: 它会复制 request 并追加流式处理器。
      sendRequest: async (request) => await runtime.send({ ...request, streamHandlers: {} }),
      flushResponseTranscript: runtime.flushResponseTranscript,
      transformAssistantMessage({ message }) {
        return { ...message, content: String(message.content).toUpperCase() };
      }
    });

    assert.equal(result.finalMessage.content, "DONE");
  }

  assert.deepEqual(responseRequestIds, [10, 10]);
  assert.deepEqual(responseResults, [{
    model: "chat-model",
    message: { role: "assistant", content: "DONE", toolCalls: undefined },
    finishReason: "stop",
    usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 }
  }, {
    model: "chat-model",
    message: { role: "assistant", content: "DONE", toolCalls: undefined },
    finishReason: "stop",
    usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 }
  }]);
});

test("token usage persistence does not perform a price lookup", () => {
  const inserted: any[] = [];
  const warnings: string[] = [];
  const store = {
    insert(event: any) {
      inserted.push(event);
      return { id: 37 };
    },
    assignProviderId() {},
    catalogNeedsRefresh() {
      return false;
    },
    recordModelPrice() {
      throw new Error("price_lookup_failed");
    }
  };
  const runtime = createTokenUsageRuntime({
    getStore: () => store as any,
    appendLog(_level, message) {
      warnings.push(message);
    }
  });

  runtime.recordTokenUsageEvent({
    createdAt: "2026-06-14T09:00:00.000",
    createdAtUtc: "2026-06-14T01:00:00.000Z",
    agentId: "chat",
    model: "chat-model",
    result: {
      message: { role: "assistant", content: "done" },
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 }
    }
  });

  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].totalTokens, 12);
  assert.equal("price" in inserted[0], false);
  assert.deepEqual(warnings, []);
});

test("main LLM requests suspend inactivity until successful settlement", async () => {
  const activity: string[] = [];
  const runtime = createLLMRequestsRuntime({
    getTool: () => undefined,
    appendLLMRequestLog: () => undefined,
    appendLLMResponseLog() {},
    appendLLMUsageLog() {},
    time: fixedTime("2026-06-14T01:00:00.000Z"),
    resolvePromptApiPreset: () => ({ model: "fallback" }),
    appendLog() {},
    agentState: {
      suspendInactivityTimer: () => activity.push("suspend"),
      restartInactivityTimer: () => activity.push("restart")
    }
  });

  await runtime.send({
    agentId: "chat",
    client: {
      async chat() {
        assert.deepEqual(activity, ["suspend"]);
        return { message: { role: "assistant", content: "done" }, finishReason: "stop" };
      }
    },
    messages: [{ role: "user", content: "hello" }],
    toolNames: [],
    round: 0
  });

  assert.deepEqual(activity, ["suspend", "restart"]);
});

test("failed main LLM requests restore inactivity while auxiliary requests do not change it", async () => {
  const activity: string[] = [];
  const runtime = createLLMRequestsRuntime({
    getTool: () => undefined,
    appendLLMRequestLog: () => undefined,
    appendLLMResponseLog() {},
    appendLLMUsageLog() {},
    time: fixedTime("2026-06-14T01:00:00.000Z"),
    resolvePromptApiPreset: () => ({ model: "fallback" }),
    appendLog() {},
    agentState: {
      suspendInactivityTimer: () => activity.push("suspend"),
      restartInactivityTimer: () => activity.push("restart")
    }
  });

  await assert.rejects(runtime.send({
    agentId: "talk",
    client: { async chat() { throw new Error("network failed"); } },
    messages: [{ role: "user", content: "hello" }],
    toolNames: [],
    round: 0
  }), /network failed/);
  assert.deepEqual(activity, ["suspend", "restart"]);

  await runtime.send({
    agentId: "asr",
    client: {
      async chat() {
        return { message: { role: "assistant", content: "done" }, finishReason: "stop" };
      }
    },
    messages: [{ role: "user", content: "audio" }],
    toolNames: [],
    round: 0
  });
  assert.deepEqual(activity, ["suspend", "restart"]);
});

test("cancelled main LLM requests restore inactivity", async () => {
  const activity: string[] = [];
  let rejectRequest: ((error: Error) => void) | undefined;
  const runtime = createLLMRequestsRuntime({
    getTool: () => undefined,
    appendLLMRequestLog: () => undefined,
    appendLLMResponseLog() {},
    appendLLMUsageLog() {},
    time: fixedTime("2026-06-14T01:00:00.000Z"),
    resolvePromptApiPreset: () => ({ model: "fallback" }),
    appendLog() {},
    agentState: {
      suspendInactivityTimer: () => activity.push("suspend"),
      restartInactivityTimer: () => activity.push("restart")
    }
  });

  const request = runtime.send({
    agentId: "chat",
    client: {
      async chat() {
        return await new Promise((_resolve, reject) => {
          rejectRequest = reject;
        });
      }
    },
    messages: [{ role: "user", content: "hello" }],
    toolNames: [],
    round: 0
  });
  assert.deepEqual(activity, ["suspend"]);

  assert.equal(runtime.cancelActive(), true);
  rejectRequest?.(new Error("aborted"));
  await assert.rejects(request, /llm_request_cancelled/);
  assert.deepEqual(activity, ["suspend", "restart"]);
});

test("LLM requests runtime writes subagent session metadata", async () => {
  const { session } = await runSubagentSession("llm-subagent-metadata");
  assert.equal(session?.meta.type, "llm_subagent_session");
  assert.equal(session?.meta.agent, "asr");
  assert.deepEqual(session?.meta.metadata, { pluginId: "asr" });
});

test("LLM requests runtime writes subagent transcript", async () => {
  const { session } = await runSubagentSession("llm-subagent-transcript");
  assert.deepEqual(session?.messages.map((message: any) => message.role), ["user", "assistant"]);
});

function createChatSessionRuntime(name: string) {
  const root = makeTempDir(name);
  const runtime = createApiSessionRuntime({
    config: { memoryFiles: { root } },
    time: fixedTime("2026-06-14T01:00:00.000Z"),
    getConversationStartIndex: () => undefined,
    buildTalkRuntimeMessages: () => [],
    appendLog() {},
    // §7.1: coordinator 为统一入口, 任何 clear 路径都必须经过它。
    sessionClearCoordinator: {
      async clearSession(request: SessionClearRequest) {
        if (!request.exists()) return { cleared: false, shortMemoryCaptured: false };
        await request.clear();
        return { cleared: true, shortMemoryCaptured: false };
      }
    }
  }).llmSessionRuntime;
  return {
    runtime,
    readCurrentSession() {
      const pointer = JSON.parse(fs.readFileSync(path.join(root, "llm-sessions", "current.json"), "utf8")) as { sessionId: number; agentType: string };
      const store = createLLMSessionStore(path.join(root, "llm-sessions.sqlite"));
      const session = store.read(String(pointer.sessionId));
      store.close();
      return { pointer, session };
    }
  };
}

function chatRequest(id: number, messages: any[]) {
  return {
    id,
    agentId: "chat" as const,
    time: "2026-06-14T01:00:00.000",
    timeUtc: "2026-06-14T01:00:00.000Z",
    model: "chat-model",
    messages
  } as any;
}

async function runSubagentSession(name: string) {
  const subagentRoot = makeTempDir(name);
  // subagentSessionRoot 现在是 llm-subagent-sessions.sqlite 的库文件路径(不再是 JSONL 目录)。
  const subagentDbPath = path.join(subagentRoot, "llm-subagent-sessions.sqlite");
  const client: LLMClient = {
    async chat() {
      return {
        model: "mimo-v2.5",
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "call_1",
            type: "function",
            function: { name: "submit_audio_context", arguments: "{\"action\":\"poll\"}" }
          }]
        },
        finishReason: "tool_calls"
      };
    }
  };
  const runtime = createLLMRequestsRuntime({
    getTool() {
      return undefined;
    },
    appendLLMRequestLog() {
      throw new Error("subagent should not use main request log");
    },
    appendLLMResponseLog() {
      throw new Error("subagent should not use main response log");
    },
    appendLLMUsageLog() {},
    time: fixedTime("2026-06-14T01:00:00.000Z"),
    resolvePromptApiPreset: () => ({ model: "fallback" }),
    appendLog() {},
    subagentSessionRoot: subagentDbPath
  });

  await runtime.send({
    agentId: "asr",
    client,
    messages: [{ role: "user", content: "audio" }],
    model: "mimo-v2.5",
    toolNames: [],
    round: 0,
    stream: false,
    metadata: { pluginId: "asr" }
  });

  const store = createLLMSessionStore(subagentDbPath);
  const sessions = store.list({ agentType: "asr", limit: 10 });
  assert.equal(sessions.length, 1, "subagent transcript must be persisted in the subagent database");
  const session = store.read(sessions[0].sessionId);
  store.close();
  return { session };
}
