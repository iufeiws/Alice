import { test } from "node:test";
import assert from "node:assert/strict";
import { createLLMRequests } from "../../../src/contexts/llm-gateway/src/llm-requests.js";
import { createTokenUsageStore } from "../../../src/platform/storage/src/token-usage-store.js";
import type { LLMClient } from "../../../src/contexts/llm-gateway/src/index.js";
import { path, makeTempDir } from "./llm-and-storage-helpers.js";

test("LLM request message sanitization removes empty assistant tool calls before reasoning", async () => {
  let requestMessages: any[] | undefined;
  const client: LLMClient = {
    async chat(input) {
      requestMessages = input.messages as any[];
      return { message: { role: "assistant", content: "done" }, finishReason: "stop" };
    }
  };
  const requests = createLLMRequests({
    getTool() {
      return undefined;
    }
  });

  await requests.send({
    agentId: "chat",
    client,
    messages: [
      { role: "assistant", content: "no tool", reasoningContent: "drop me" },
      { role: "assistant", content: "empty tools", reasoningContent: "drop me too", toolCalls: [] }
    ],
    model: "core-model",
    toolNames: [],
    round: 0
  });

  assert.equal(requestMessages?.[0].content, "no tool\nempty tools");
  assert.equal(requestMessages?.[0].reasoningContent, undefined);
  assert.equal(requestMessages?.[0].toolCalls, undefined);
});

test("LLM request message sanitization preserves reasoning for assistant tool calls", async () => {
  let requestMessages: any[] | undefined;
  const client: LLMClient = {
    async chat(input) {
      requestMessages = input.messages as any[];
      return { message: { role: "assistant", content: "done" }, finishReason: "stop" };
    }
  };
  const requests = createLLMRequests({
    getTool() {
      return undefined;
    }
  });

  await requests.send({
    agentId: "chat",
    client,
    messages: [
      {
        role: "assistant",
        content: "tool",
        reasoningContent: "keep me",
        toolCalls: [{
          id: "call_1",
          type: "function",
          function: { name: "Chat", arguments: "{\"action\":\"poll\"}" }
        }]
      }
    ],
    model: "core-model",
    toolNames: [],
    round: 0
  });

  assert.equal(requestMessages?.[0].content, "tool");
  assert.equal(requestMessages?.[0].reasoningContent, "keep me");
});

test("LLM request message sanitization preserves assistant tool calls when disabled", async () => {
  let requestMessages: any[] | undefined;
  const client: LLMClient = {
    async chat(input) {
      requestMessages = input.messages as any[];
      return { message: { role: "assistant", content: "done" }, finishReason: "stop" };
    }
  };
  const requests = createLLMRequests({
    getTool() {
      return undefined;
    },
    messageSanitization: {
      removeEmptyAssistantToolCalls: false
    }
  });

  await requests.send({
    agentId: "chat",
    client,
    messages: [
      { role: "assistant", content: "", toolCalls: [] }
    ],
    model: "core-model",
    toolNames: [],
    round: 0
  });

  assert.deepEqual(requestMessages?.[0].toolCalls, []);
});

test("LLM request message sanitization preserves assistant reasoning without tool calls when disabled", async () => {
  let requestMessages: any[] | undefined;
  const client: LLMClient = {
    async chat(input) {
      requestMessages = input.messages as any[];
      return { message: { role: "assistant", content: "done" }, finishReason: "stop" };
    }
  };
  const requests = createLLMRequests({
    getTool() {
      return undefined;
    },
    messageSanitization: {
      removeAssistantReasoningWithoutToolCall: false
    }
  });

  await requests.send({
    agentId: "chat",
    client,
    messages: [
      { role: "assistant", content: "", reasoningContent: "keep" }
    ],
    model: "core-model",
    toolNames: [],
    round: 0
  });

  assert.equal(requestMessages?.[0].reasoningContent, "keep");
});

test("LLM request message sanitization preserves consecutive assistant messages when disabled", async () => {
  let requestMessages: any[] | undefined;
  const client: LLMClient = {
    async chat(input) {
      requestMessages = input.messages as any[];
      return { message: { role: "assistant", content: "done" }, finishReason: "stop" };
    }
  };
  const requests = createLLMRequests({
    getTool() {
      return undefined;
    },
    messageSanitization: {
      mergeConsecutiveAssistantContent: false
    }
  });

  await requests.send({
    agentId: "chat",
    client,
    messages: [
      { role: "assistant", content: "first" },
      { role: "assistant", content: "second" }
    ],
    model: "core-model",
    toolNames: [],
    round: 0
  });

  assert.deepEqual(requestMessages?.map((message) => message.content), ["first", "second"]);
});

test("LLM request message sanitization merges consecutive assistant content", async () => {
  let requestMessages: any[] | undefined;
  const client: LLMClient = {
    async chat(input) {
      requestMessages = input.messages as any[];
      return { message: { role: "assistant", content: "done" }, finishReason: "stop" };
    }
  };
  const requests = createLLMRequests({
    getTool() {
      return undefined;
    }
  });

  await requests.send({
    agentId: "chat",
    client,
    messages: [
      { role: "assistant", content: "one" },
      { role: "assistant", content: "two" },
      { role: "user", content: "break" },
      { role: "assistant", content: "three" },
      {
        role: "assistant",
        content: "tool",
        toolCalls: [{
          id: "call_1",
          type: "function",
          function: { name: "Chat", arguments: "{\"action\":\"poll\"}" }
        }]
      },
      { role: "assistant", content: "four" }
    ],
    model: "core-model",
    toolNames: [],
    round: 0
  });

  assert.deepEqual(requestMessages?.map((message) => `${message.role}:${message.content}`), [
    "assistant:one\ntwo",
    "user:break",
    "assistant:three",
    "assistant:tool",
    "assistant:four"
  ]);
});

test("LLM request sender renders tool variables in extra params", async () => {
  let request: any;
  const client: LLMClient = {
    async chat(input) {
      request = input;
      return { message: { role: "assistant", content: "ok" }, finishReason: "stop" };
    }
  };
  const requests = createLLMRequests({
    getTool() {
      return undefined;
    }
  });

  await requests.send({
    agentId: "asr",
    client,
    messages: [],
    extraParams: {
      tool_choice: {
        type: "function",
        function: { name: "{{toolName}}" }
      }
    },
    toolNames: ["submit_audio_context"],
    inlineTools: [{
      name: "submit_audio_context",
      description: "",
      inputSchema: {
        type: "object",
        properties: {
          speakText: { type: "string" }
        }
      }
    }],
    toolVariables: {
      toolName: "submit_audio_context"
    },
    round: 0,
    stream: false
  });

  assert.deepEqual(request.extraParams, {
    tool_choice: {
      type: "function",
      function: { name: "submit_audio_context" }
    }
  });
});

test("LLM request sender supports inline tools", async () => {
  let request: any;
  const client: LLMClient = {
    async chat(input) {
      request = input;
      return { message: { role: "assistant", content: "ok" }, finishReason: "stop" };
    }
  };
  const requests = createLLMRequests({
    getTool() {
      return undefined;
    }
  });

  await requests.send({
    agentId: "asr",
    client,
    messages: [],
    toolNames: ["submit_audio_context"],
    inlineTools: [{
      name: "submit_audio_context",
      description: "",
      inputSchema: {
        type: "object",
        properties: {
          speakText: { type: "string" }
        }
      }
    }],
    round: 0,
    stream: false
  });

  assert.equal(request.tools[0].function.name, "submit_audio_context");
});

test("LLM request sender adds stream usage options when streaming is enabled", async () => {
  let request: any;
  const client: LLMClient = {
    async chat() {
      throw new Error("chat should not be used for streaming requests");
    },
    async chatStream(input) {
      request = input;
      return { message: { role: "assistant", content: "ok" }, finishReason: "stop" };
    }
  };
  const requests = createLLMRequests({
    getTool() {
      return undefined;
    }
  });

  await requests.send({
    agentId: "chat",
    client,
    messages: [],
    extraParams: {
      stream_options: {
        include_usage: false,
        foo: "bar"
      }
    },
    toolNames: [],
    round: 0,
    stream: true
  });

  assert.deepEqual(request.extraParams.stream_options, {
    include_usage: true,
    foo: "bar"
  });
});

test("LLM request sender treats extra param stream true as streaming", async () => {
  let request: any;
  const client: LLMClient = {
    async chat() {
      throw new Error("chat should not be used when extra params enable stream");
    },
    async chatStream(input) {
      request = input;
      return { message: { role: "assistant", content: "ok" }, finishReason: "stop" };
    }
  };
  const requests = createLLMRequests({
    getTool() {
      return undefined;
    }
  });

  await requests.send({
    agentId: "chat",
    client,
    messages: [],
    extraParams: {
      stream: true
    },
    toolNames: [],
    round: 0
  });

  assert.deepEqual(request.extraParams.stream_options, {
    include_usage: true
  });
});

test("LLM request response content sanitization setting can be disabled", async () => {
  const client: LLMClient = {
    async chat() {
      return {
        message: {
          role: "assistant",
          content: "喂（电话那头沉默了一会儿，只有细微的呼吸声）我在。"
        },
        finishReason: "stop"
      };
    }
  };
  const requests = createLLMRequests({
    getTool() {
      return undefined;
    },
    messageSanitization: {
      removeParenthesizedAssistantResponseContent: false
    }
  });

  const result = await requests.send({
    agentId: "chat",
    client,
    messages: [],
    model: "core-model",
    toolNames: [],
    round: 0
  });

  assert.equal(result.message.content, "喂（电话那头沉默了一会儿，只有细微的呼吸声）我在。");
});

test("LLMRequests builds tools by name with stable order", async () => {
  const requests = createLLMRequests({
    getTool(name) {
      return {
        first: { name: "first", description: "First {{name}}", inputSchema: { type: "object", properties: { a: { const: "{{value}}" } } } },
        second: { name: "second", description: "Second", inputSchema: { type: "object" } }
      }[name];
    }
  });

  const tools = requests.buildTools(["second", "first", "second"], { name: "tool", value: "v" });
  assert.deepEqual(tools.map((tool) => tool.function.name), ["second", "first"]);
  assert.deepEqual(tools[1].function.parameters?.properties, { a: { const: "v" } });
});

test("LLMRequests rejects unknown tools", async () => {
  const requests = createLLMRequests({
    getTool() {
      return undefined;
    }
  });

  assert.throws(() => requests.buildTools(["missing"]), /unknown LLM tool: missing/);
});

test("LLMRequests records memorize token usage through response hook", async () => {
  const dir = makeTempDir("llm-requests-usage");
  const store = createTokenUsageStore(path.join(dir, "token-usage.sqlite"));
  const client: LLMClient = {
    async chat(input) {
      return {
        model: input.model,
        message: { role: "assistant", content: "done" },
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, cacheHitTokens: 4, cacheMissTokens: 6 },
        raw: { usage: { prompt_tokens: 10 } }
      };
    }
  };
  const requests = createLLMRequests({
    getTool(name) {
      return name === "read_memory" ? { name, description: "read", inputSchema: { type: "object" } } : undefined;
    },
    onResponseReceived(input, request, result) {
      store.insert({
        createdAt: "2026-05-30T10:00:00.000",
        agentId: input.agentId,
        model: result.model ?? request.model,
        inputTokens: result.usage?.inputTokens,
        outputTokens: result.usage?.outputTokens,
        totalTokens: result.usage?.totalTokens,
        cacheHitTokens: result.usage?.cacheHitTokens,
        cacheMissTokens: result.usage?.cacheMissTokens
      });
    }
  });

  await requests.send({
    agentId: "memorize",
    client,
    messages: [],
    model: "memorize-model",
    toolNames: ["read_memory"],
    round: 0
  });

  const report = store.report({ agentId: "memorize" });
  assert.equal(report.summary.requests, 1);
  assert.equal(report.summary.totalTokens, 12);
  assert.equal(report.byModel[0].model, "memorize-model");
});

test("LLMRequests does not retry a successful call when response hook fails", async () => {
  let calls = 0;
  const client: LLMClient = {
    async chat() {
      calls += 1;
      return { message: { role: "assistant", content: "done" }, finishReason: "stop" };
    }
  };
  const requests = createLLMRequests({
    getTool() {
      return undefined;
    },
    onResponseReceived() {
      throw new Error("503 observer failed after success");
    }
  });

  await assert.rejects(() => requests.send({
    agentId: "memorize",
    client,
    messages: [],
    model: "memorize-model",
    toolNames: [],
    round: 0
  }), /observer failed/);
  assert.equal(calls, 1);
});

test("LLMRequests cancels the active request signal", async () => {
  let signal: AbortSignal | undefined;
  let responseHookCalls = 0;
  let clientStarted: (() => void) | undefined;
  const clientStartedPromise = new Promise<void>((resolve) => {
    clientStarted = resolve;
  });
  let resolveLateResponse: (() => void) | undefined;
  const client: LLMClient = {
    chat(input) {
      signal = input.signal;
      clientStarted?.();
      return new Promise((resolve, reject) => {
        input.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        resolveLateResponse = () => resolve({ message: { role: "assistant", content: "late" } });
      });
    }
  };
  const requests = createLLMRequests({
    getTool() {
      return undefined;
    },
    onResponseReceived() {
      responseHookCalls += 1;
    }
  });

  const pending = requests.send({
    agentId: "chat",
    client,
    messages: [],
    model: "core-model",
    toolNames: [],
    round: 0
  });
  await clientStartedPromise;
  assert.equal(requests.cancelActive(), true);
  await assert.rejects(() => pending, /llm_request_cancelled/);
  assert.equal(signal?.aborted, true);
  assert.equal(responseHookCalls, 0);
  resolveLateResponse?.();
});

test("LLMRequests external abort targets the matching request controller", async () => {
  const signals: AbortSignal[] = [];
  const resolvers: Array<() => void> = [];
  const client: LLMClient = {
    chat(input) {
      const index = signals.length;
      if (!input.signal) throw new Error("missing signal");
      signals.push(input.signal);
      return new Promise((resolve, reject) => {
        input.signal?.addEventListener("abort", () => reject(new Error(`client_aborted_${index}`)), { once: true });
        resolvers[index] = () => resolve({ message: { role: "assistant", content: `done-${index}` }, finishReason: "stop" });
      });
    }
  };
  const requests = createLLMRequests({
    getTool() {
      return undefined;
    }
  });
  const firstController = new AbortController();

  const first = requests.send({
    agentId: "talk",
    client,
    messages: [],
    model: "core-model",
    toolNames: [],
    round: 0,
    signal: firstController.signal
  });
  await waitFor(() => signals.length === 1);
  const second = requests.send({
    agentId: "chat",
    client,
    messages: [],
    model: "core-model",
    toolNames: [],
    round: 0
  });
  await waitFor(() => signals.length === 2);

  firstController.abort();

  await assert.rejects(() => first, /llm_request_cancelled/);
  assert.equal(signals[0]?.aborted, true);
  assert.equal(signals[1]?.aborted, false);
  resolvers[1]?.();
  assert.equal((await second).message.content, "done-1");
});

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("condition was not met before timeout");
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
