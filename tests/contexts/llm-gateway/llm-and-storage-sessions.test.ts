import { test } from "node:test";
import assert from "node:assert/strict";
import { createLLMRequestsRuntime } from "../../../src/contexts/llm-gateway/src/llm-requests-runtime.js";
import { createLLMLogRuntime } from "../../../src/contexts/llm-gateway/src/llm-log-runtime.js";
import { createApiSessionRuntime } from "../../../src/contexts/llm-session/src/index.js";
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
    appendUsageLog() {},
    resolveModel: () => "model",
    recordTokenUsage() {}
  });

  const request = logRuntime.appendRequestLog({
    messages: [{ role: "user", content: "hello" }],
    model: "chat-model",
    presetName: "chat-flash",
    extraParams: { tool_choice: { type: "function", function: { name: "Chat" } } }
  }, "chat");
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
});

test("LLM session runtime writes chat request directly to jsonl", () => {
  const { runtime, filePathFor } = createChatSessionRuntime("llm-session-request-jsonl");
  const request = chatRequest(1, [
    { role: "system" as const, content: "system" },
    { role: "user" as const, content: "hello" }
  ]);
  runtime.noteLLMRequest(request, "chat");

  const filePath = filePathFor();
  assert.deepEqual(readLLMSessionJsonl(filePath)?.messages.map((message) => message.role), ["system", "user"]);
});

test("LLM session runtime appends chat response directly to jsonl", () => {
  const { runtime, filePathFor } = createChatSessionRuntime("llm-session-response-jsonl");
  const request = chatRequest(1, [
    { role: "system" as const, content: "system" },
    { role: "user" as const, content: "hello" }
  ]);
  runtime.noteLLMRequest(request, "chat");

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
  const filePath = filePathFor();
  assert.deepEqual(readLLMSessionJsonl(filePath)?.messages.map((message) => message.role), ["system", "user", "assistant"]);
});

test("LLM session runtime records latest chat request metadata", () => {
  const { runtime, filePathFor } = createChatSessionRuntime("llm-session-latest-request");
  const request = chatRequest(1, [
    { role: "system" as const, content: "system" },
    { role: "user" as const, content: "hello" }
  ]);
  runtime.noteLLMRequest(request, "chat");
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

  runtime.noteLLMRequest({
    id: 3,
    agentId: "chat",
    time: "2026-06-14T01:00:02.000",
    timeUtc: "2026-06-14T01:00:02.000Z",
    model: "chat-model",
    messages: [
      { role: "system", content: "system" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "done" },
      { role: "user", content: "again" }
    ]
  }, "chat");
  const filePath = filePathFor();
  const metadata = readLLMSessionJsonl(filePath)?.metadata;
  assert.equal((metadata?.latestRequest as any)?.round, 1);
  assert.deepEqual(metadata?.requestIds, [1, 3]);
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
        messages: request.messages,
        presetName: request.presetName
      };
    },
    appendLLMResponseLog(_result, _agentId, request) {
      responseRequestIds.push(request?.id);
    },
    appendLLMUsageLog() {},
    recordTokenUsageEvent() {},
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

test("LLM requests runtime writes subagent session metadata", async () => {
  const { parsed } = await runSubagentSession("llm-subagent-metadata");
  assert.equal(parsed?.metadata.type, "llm_subagent_session");
  assert.equal(parsed?.metadata.agent, "asr");
  assert.deepEqual(parsed?.metadata.metadata, { pluginId: "asr" });
});

test("LLM requests runtime writes subagent transcript", async () => {
  const { parsed } = await runSubagentSession("llm-subagent-transcript");
  assert.deepEqual(parsed?.messages.map((message) => message.role), ["user", "assistant"]);
});

test("LLM requests runtime records subagent token usage", async () => {
  const { usageEvents } = await runSubagentSession("llm-subagent-usage");
  assert.deepEqual(usageEvents.map((event) => event.agentId), ["asr"]);
});

function createChatSessionRuntime(name: string) {
  const root = makeTempDir(name);
  const runtime = createApiSessionRuntime({
    config: { memoryFiles: { root } },
    time: fixedTime("2026-06-14T01:00:00.000Z"),
    getConversationStartIndex: () => undefined,
    buildTalkRuntimeMessages: () => [],
    appendLog() {}
  }).llmSessionRuntime;
  return {
    runtime,
    filePathFor() {
      const pointer = JSON.parse(fs.readFileSync(path.join(root, "llm-sessions", "current.json"), "utf8")) as { path: string };
      return path.join(root, "llm-sessions", pointer.path);
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
  const usageEvents: any[] = [];
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
    recordTokenUsageEvent(event) {
      usageEvents.push(event);
    },
    time: fixedTime("2026-06-14T01:00:00.000Z"),
    resolvePromptApiPreset: () => ({ model: "fallback" }),
    appendLog() {},
    subagentSessionRoot: subagentRoot
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

  const sessionDir = path.join(subagentRoot, "asr", "2026-06-14");
  const files = fs.readdirSync(sessionDir).filter((entry) => entry.endsWith(".jsonl"));
  assert.equal(files.length, 1);
  return { parsed: readLLMSessionJsonl(path.join(sessionDir, files[0])), usageEvents };
}
