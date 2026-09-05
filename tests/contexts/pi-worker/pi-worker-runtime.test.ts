import test from "node:test";
import assert from "node:assert/strict";
import { createPiWorkerRuntime, type PiInvocationCompletion, type PiInvocationStatus, type PiSessionSnapshot, type PiToolDefinition, type PiWorkerClient, type PiWorkerHealth } from "../../../src/contexts/pi-worker/src/index.js";
import { createFileTools } from "../../../src/capabilities/tools/file/src/index.js";
import { createShellTools } from "../../../src/capabilities/tools/shell/src/index.js";
import { createSubAgentTool } from "../../../src/capabilities/tools/subagent/src/index.js";
import { subAgentTool } from "../../../src/capabilities/tools/subagent/profile.js";

const health: PiWorkerHealth = {
  ready: true,
  activeRuns: 0,
  version: "1.2.3",
  toolDefinitionGeneration: "generation-a",
  cwd: "/home/alice",
  relayReachable: true,
  toolDefinitions: [
    { name: "read", description: "native read", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
    { name: "write", description: "native write", inputSchema: { type: "object" } },
    { name: "edit", description: "native edit", inputSchema: { type: "object" } },
    { name: "bash", description: "native bash", inputSchema: { type: "object" } },
    { name: "grep", description: "not exposed", inputSchema: { type: "object" } }
  ]
};

test("File tool plugin exposes static Read/Write/Edit definitions and forwards container tools with lowercased names", async () => {
  const worker = fakeWorker();
  const runtime = createPiWorkerRuntime({ worker, prepareModel: () => ({ model: "model-a", supportsImage: false, reasoning: false }) });
  await runtime.start();
  const tool = createFileTools({ piWorker: runtime });
  assert.deepEqual(tool.listTools().map((definition) => definition.name), ["Read", "Write", "Edit"]);
  const result = await tool.execute({ id: "call-1", toolName: "Read", input: { path: "a.txt" } });
  assert.equal(result.ok, true);
  assert.deepEqual(worker.lastTool, { toolName: "read", input: { path: "a.txt" } });
  await runtime.stop();
});

test("Shell tool plugin exposes the static Bash definition and forwards it with the lowercased name", async () => {
  const worker = fakeWorker();
  const runtime = createPiWorkerRuntime({ worker, prepareModel: () => ({ model: "model-a", supportsImage: false, reasoning: false }) });
  await runtime.start();
  const tool = createShellTools({ runtime });
  assert.deepEqual(tool.listTools().map((definition) => definition.name), ["Bash"]);
  const result = await tool.execute({ id: "call-4", toolName: "Bash", input: { command: "ls" } });
  assert.equal(result.ok, true);
  assert.deepEqual(worker.lastTool, { toolName: "bash", input: { command: "ls" } });
  await runtime.stop();
});

test("File and shell text results reach the LLM as plain text", async () => {
  const worker = fakeWorker();
  worker.executeTool = async ({ toolName }) => ({
    ok: true,
    content: [{ type: "text", text: toolName === "read" ? "test\nalice\nPI_MAX_CONCURRENCY=2" : "stdout" }]
  });
  const runtime = createPiWorkerRuntime({ worker, prepareModel: () => ({ model: "model-a", supportsImage: false, reasoning: false }) });
  await runtime.start();
  const fileTool = createFileTools({ piWorker: runtime });
  const shellTool = createShellTools({ runtime });

  const fileResult = await fileTool.execute({ id: "call-file-text", toolName: "Read", input: { path: "/tmp/env" } });
  const shellResult = await shellTool.execute({ id: "call-shell-text", toolName: "Bash", input: { command: "env" } });

  assert.equal(fileResult.output, "test\nalice\nPI_MAX_CONCURRENCY=2");
  assert.equal(shellResult.output, "stdout");
  await runtime.stop();
});

test("SubAgent exposes the seven public actions with their fixed nickname description", () => {
  assert.equal(subAgentTool.description, [
    "spawn：创建新的持久化 SubAgent session 并提交第一条任务消息，立即返回 nickname，不等待任务完成。",
    "messages：读取指定 nickname 对应 session 的 Pi 原始消息，并用 access 按 Python 索引或切片语义读取，例如 -1、:3、2:。",
    "result：读取指定 nickname 对应 session 当前任务的结果；完成时返回最新 assistant message，运行中返回 running，其他终态只返回状态。",
    "send：向指定 nickname 对应 session 提交一条新任务消息并立即返回原 nickname；需要结果时再调用 result。",
    "status：非阻塞查询指定 nickname 对应 session 的单一状态、最后更新时间和可见消息数量，状态包含 queued、running 及五种终态。",
    "cancel：请求取消指定 nickname 对应 session 当前运行或排队的任务，成功返回 cancelled，session 保持可复用。",
    "fork：从指定 nickname 对应 session 创建独立的新 session，可用 entryId 指定历史分支点，成功返回新 nickname。"
  ].join("\n"));
  assert.equal(subAgentTool.description.includes("wait："), false);
  const inputSchema = subAgentTool.inputSchema as {
    type: string;
    properties: Record<string, { type?: string; enum?: string[]; minLength?: number; minimum?: number }>;
    required: string[];
    additionalProperties: boolean;
    oneOf?: unknown;
  };
  assert.equal(inputSchema.type, "object");
  assert.equal(inputSchema.properties.action.type, "string");
  assert.deepEqual(inputSchema.properties.action.enum, ["spawn", "messages", "result", "send", "status", "cancel", "fork"]);
  assert.equal(inputSchema.properties.message.type, "string");
  assert.equal(inputSchema.properties.message.minLength, 1);
  assert.equal(inputSchema.properties.nickname.type, "string");
  assert.equal(inputSchema.properties.nickname.minLength, 1);
  assert.equal(inputSchema.properties.access.type, "string");
  assert.equal(inputSchema.properties.access.minLength, 1);
  assert.equal(inputSchema.properties.timeoutSeconds.type, "number");
  assert.equal(inputSchema.properties.timeoutSeconds.minimum, 1);
  assert.equal(inputSchema.properties.entryId.type, "string");
  assert.equal(inputSchema.properties.entryId.minLength, 1);
  assert.deepEqual(inputSchema.required, ["action"]);
  assert.equal(inputSchema.additionalProperties, false);
  assert.equal(inputSchema.oneOf, undefined);
});

test("SubAgent projects messages, result, status, wait, cancel and fork without internal fields", async () => {
  const worker = fakeWorker();
  worker.sessionMessages = async (_sessionId: string, access: string) => {
    assert.equal(access, ":3");
    return [{ role: "user", content: "task" }, { role: "assistant", content: "done" }];
  };
  worker.subAgentStatus = async () => ({ updatedAt: "2026-08-05T12:00:00.000", messages: 2, status: "completed" });
  worker.resultSession = async () => ({ status: "completed", message: { role: "assistant", content: "done" } });
  worker.waitSession = async () => ({ status: "completed", message: { role: "assistant", content: "done" } });
  worker.cancelSession = async () => "cancelled";
  const runtime = createPiWorkerRuntime({ worker, prepareModel: () => ({ model: "model-a", supportsImage: false, reasoning: false }) });
  await runtime.start();
  const tool = createSubAgentTool({ runtime });
  assert.deepEqual((await tool.execute({ id: "messages", toolName: "SubAgent", input: { action: "messages", nickname: "pikachu", access: ":3" } })).output, [
    { role: "user", content: "task" }, { role: "assistant", content: "done" }
  ]);
  assert.deepEqual((await tool.execute({ id: "result", toolName: "SubAgent", input: { action: "result", nickname: "pikachu" } })).output, { status: "completed", message: { role: "assistant", content: "done" } });
  assert.deepEqual((await tool.execute({ id: "status", toolName: "SubAgent", input: { action: "status", nickname: "pikachu" } })).output, { updatedAt: "2026-08-05T12:00:00.000", messages: 2, status: "completed" });
  assert.deepEqual((await tool.execute({ id: "wait", toolName: "SubAgent", input: { action: "wait", nickname: "pikachu" } })).output, { status: "completed", message: { role: "assistant", content: "done" } });
  assert.equal((await tool.execute({ id: "cancel", toolName: "SubAgent", input: { action: "cancel", nickname: "pikachu" } })).output, "cancelled");
  assert.deepEqual((await tool.execute({ id: "fork", toolName: "SubAgent", input: { action: "fork", nickname: "pikachu" } })).output, { nickname: "raichu" });
  await runtime.stop();
});

test("SubAgent result returns the completed message or running state", async () => {
  const worker = fakeWorker();
  worker.resultSession = async () => ({ status: "completed", message: { role: "assistant", content: "done" } });
  const runtime = createPiWorkerRuntime({ worker, prepareModel: () => ({ model: "model-a", supportsImage: false, reasoning: false }) });
  await runtime.start();
  const tool = createSubAgentTool({ runtime });
  assert.deepEqual((await tool.execute({ id: "result", toolName: "SubAgent", input: { action: "result", nickname: "pikachu" } })).output, {
    status: "completed",
    message: { role: "assistant", content: "done" }
  });
  worker.resultSession = async () => ({ status: "running" });
  assert.deepEqual((await tool.execute({ id: "result-running", toolName: "SubAgent", input: { action: "result", nickname: "pikachu" } })).output, { status: "running" });
  await runtime.stop();
});

test("SubAgent messages truncates long serialized results to 1024 characters at each edge", async () => {
  const worker = fakeWorker();
  const longText = `HEAD${"x".repeat(3000)}TAIL`;
  worker.sessionMessages = async () => [{ role: "assistant", content: longText }];
  const runtime = createPiWorkerRuntime({ worker, prepareModel: () => ({ model: "model-a", supportsImage: false, reasoning: false }) });
  await runtime.start();
  const tool = createSubAgentTool({ runtime });
  const result = await tool.execute({ id: "messages-long", toolName: "SubAgent", input: { action: "messages", nickname: "pikachu", access: ":" } });
  assert.equal(typeof result.output, "string");
  const output = result.output as string;
  const serialized = JSON.stringify([{ role: "assistant", content: longText }]);
  assert.ok(output.startsWith(serialized.slice(0, 1024)));
  assert.ok(output.endsWith(serialized.slice(-1024)));
  assert.match(output, /<subagent_messages_truncated omitted_chars="\d+" \/>/);
  await runtime.stop();
});

test("SubAgent rejects legacy actions, mode, empty entry ids and extra fields", async () => {
  const worker = fakeWorker();
  const runtime = createPiWorkerRuntime({ worker, prepareModel: () => ({ model: "model-a", supportsImage: false, reasoning: false }) });
  await runtime.start();
  const tool = createSubAgentTool({ runtime });
  for (const input of [
    { action: "start", message: "task" },
    { action: "read", sessionId: "session-1", view: "messages" },
    { action: "list" },
    { action: "send", sessionId: "session-1", message: "task", mode: "prompt" },
    { action: "fork", sessionId: "session-1", entryId: "" },
    { action: "status", sessionId: "session-1", extra: true }
  ]) {
    await assert.rejects(tool.execute({ id: "invalid", toolName: "SubAgent", input }), /invalid_subagent_input/);
  }
  await runtime.stop();
});

test("SubAgent invalid input errors identify the exact parameter problem", async () => {
  const worker = fakeWorker();
  const runtime = createPiWorkerRuntime({ worker, prepareModel: () => ({ model: "model-a", supportsImage: false, reasoning: false }) });
  await runtime.start();
  const tool = createSubAgentTool({ runtime });

  await assert.rejects(
    tool.execute({ id: "spawn-nickname", toolName: "SubAgent", input: { action: "spawn", message: "task", nickname: "test-alice" } }),
    /invalid_subagent_input: spawn 不应提供参数 nickname/
  );
  await assert.rejects(
    tool.execute({ id: "spawn-message", toolName: "SubAgent", input: { action: "spawn" } }),
    /invalid_subagent_input: spawn 缺少必填参数 message/
  );
  await assert.rejects(
    tool.execute({ id: "wait-timeout", toolName: "SubAgent", input: { action: "wait", nickname: "pikachu", timeoutSeconds: 0 } }),
    /invalid_subagent_input: wait 的 timeoutSeconds 必须是大于 0 的有限数字/
  );
  await assert.rejects(
    tool.execute({ id: "unknown-action", toolName: "SubAgent", input: { action: "start", message: "task" } }),
    /invalid_subagent_input: 不支持的 action start/
  );
  await runtime.stop();
});

test("Pi image tool results become image follow-up attachments for multimodal Chat", async () => {
  const worker = fakeWorker();
  worker.executeTool = async () => ({ ok: true, content: [{ type: "text", text: "photo" }, { type: "image", data: "aGVsbG8=", mimeType: "image/png" }] });
  const runtime = createPiWorkerRuntime({ worker, prepareModel: () => ({ model: "model-a", supportsImage: false, reasoning: false }) });
  await runtime.start();
  const tool = createFileTools({ piWorker: runtime });
  const result = await tool.execute({ id: "call-image", toolName: "Read", input: {} }, { llmCapabilities: { supportsImage: true } });
  assert.equal(result.output, "photo");
  assert.deepEqual(result.llmFollowupAttachments, [{ kind: "image", data: "aGVsbG8=", mime: "image/png" }]);
  await runtime.stop();
});

test("Pi image tool results go through image recognition for non-multimodal Chat, passing base64 directly", async () => {
  const worker = fakeWorker();
  worker.executeTool = async () => ({ ok: true, content: [{ type: "text", text: "photo" }, { type: "image", data: "aGVsbG8=", mimeType: "image/png" }] });
  const runtime = createPiWorkerRuntime({ worker, prepareModel: () => ({ model: "model-a", supportsImage: false, reasoning: false }) });
  await runtime.start();
  const targets: unknown[] = [];
  const tool = createFileTools({
    piWorker: runtime,
    recognizeImage: async (target) => { targets.push(target); return { text: "recognized" }; }
  });
  const result = await tool.execute({ id: "call-image-recognition", toolName: "Read", input: {} }, { llmCapabilities: { supportsImage: false } });
  assert.equal(result.ok, true);
  assert.equal(result.output, "photo\nrecognized");
  assert.deepEqual(targets, [{ data: "aGVsbG8=", mimeType: "image/png" }]);
  assert.equal(result.llmFollowupAttachments, undefined);
  await runtime.stop();
});

test("terminal invocations notify once with final text", async () => {
  const worker = fakeWorker();
  const delivered: PiInvocationCompletion[] = [];
  const runtime = createPiWorkerRuntime({
    worker,
    pollIntervalMs: 1,
    prepareModel: () => ({ model: "model-a", supportsImage: false, reasoning: false }),
    onInvocationCompleted: (completion) => { delivered.push(completion); }
  });
  await runtime.start();
  await runtime.startSubAgent({ message: "finish" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(delivered.map((entry) => entry.text), ["done"]);
  await runtime.stop();
});

test("refresh refreshes the tool registry from the new worker health before resolving", async () => {
  let gen = "a";
  const worker = fakeWorker();
  worker.health = async () => ({
    ready: true,
    activeRuns: 0,
    version: "1.2.3",
    toolDefinitionGeneration: "generation-a",
    cwd: "/home/alice",
    relayReachable: true,
    toolDefinitions: [{ name: "read", description: "native read", inputSchema: { gen } }]
  });
  const order: string[] = [];
  let capturedDefinitions: PiToolDefinition[] = [];
  const runtime = createPiWorkerRuntime({
    worker,
    prepareModel: () => ({ model: "model-a", supportsImage: false, reasoning: false }),
    refreshAuthorization: async () => { order.push("worker"); gen = "b"; },
    refreshToolRegistry: () => { order.push("refresh"); capturedDefinitions = runtime.toolDefinitions(); }
  });
  await runtime.start();
  await runtime.refresh("config");
  assert.equal(capturedDefinitions[0].inputSchema.gen, "b");
  // start() 不再握手; refresh("config") 做一次握手 + 一次工具注册表刷新。
  assert.deepEqual(order, ["worker", "refresh"]);
  await runtime.stop();
});

test("refresh failure is contained at the runtime level: resolves, degrades health and logs", async () => {
  const worker = fakeWorker();
  const logged: string[] = [];
  const runtime = createPiWorkerRuntime({
    worker,
    prepareModel: () => ({ model: "model-a", supportsImage: false, reasoning: false }),
    refreshAuthorization: async () => { throw new Error("fetch failed"); },
    appendLog: (level, message) => { logged.push(`${level}:${message}`); }
  });
  await runtime.start();
  await runtime.refresh("config");
  // 不向调用方(admin 主流程)抛错; worker 不可达时 pi 工具降级为空。
  assert.deepEqual(runtime.toolDefinitions(), []);
  assert.equal(logged.some((entry) => entry.includes("pi worker refresh failed")), true);
  await runtime.stop();
});

test("refresh tool registry failure is contained and logged, never rejected", async () => {
  const worker = fakeWorker();
  const logged: string[] = [];
  const runtime = createPiWorkerRuntime({
    worker,
    prepareModel: () => ({ model: "model-a", supportsImage: false, reasoning: false }),
    refreshToolRegistry: () => { throw new Error("pi_tool_registry_refresh_failed"); },
    appendLog: (level, message) => { logged.push(`${level}:${message}`); }
  });
  await runtime.start();
  await runtime.refresh("config");
  assert.equal(logged.some((entry) => entry.includes("pi worker refresh failed")), true);
  await runtime.stop();
});

test("wakeIfNeeded does a single background handshake and swallows failures for the next heartbeat", async () => {
  const worker = fakeWorker();
  const logged: string[] = [];
  let handshakes = 0;
  const runtime = createPiWorkerRuntime({
    worker,
    wakeIntervalMs: 0,
    prepareModel: () => ({ model: "model-a", supportsImage: false, reasoning: false }),
    refreshAuthorization: async () => { handshakes += 1; throw new Error("fetch failed"); },
    appendLog: (level, message) => { logged.push(`${level}:${message}`); }
  });
  await runtime.start();
  await runtime.wakeIfNeeded();
  // 单次尝试、失败不抛给 heartbeat 主流程。
  assert.equal(handshakes, 1);
  assert.equal(logged.some((entry) => entry.includes("pi worker wake failed")), true);
  await runtime.stop();
});

test("wakeIfNeeded is throttled by wakeIntervalMs", async () => {
  const worker = fakeWorker();
  let handshakes = 0;
  const runtime = createPiWorkerRuntime({
    worker,
    wakeIntervalMs: 60_000,
    prepareModel: () => ({ model: "model-a", supportsImage: false, reasoning: false }),
    refreshAuthorization: async () => { handshakes += 1; }
  });
  await runtime.start();
  await runtime.wakeIfNeeded();
  await runtime.wakeIfNeeded();
  // 间隔内的第二次调用被节流跳过。
  assert.equal(handshakes, 1);
  await runtime.stop();
});

test("watch delivers every terminal invocation, not only the latest", async () => {
  const worker = fakeWorker();
  let completions: PiInvocationCompletion[] = [
    { sessionId: "session-1", nickname: "pikachu", invocationId: "inv-1", status: "completed", text: "first" }
  ];
  worker.sessionStatusBySessionId = async () => ({
    sessionId: "session-1",
    idle: false,
    invocationStatus: "running",
    createdAt: "2026-08-05T12:00:00.000",
    updatedAt: "2026-08-05T12:00:00.000",
    terminalCompletions: completions
  });
  const delivered: PiInvocationCompletion[] = [];
  const runtime = createPiWorkerRuntime({
    worker,
    pollIntervalMs: 1,
    prepareModel: () => ({ model: "model-a", supportsImage: false, reasoning: false }),
    onInvocationCompleted: (completion) => { delivered.push(completion); }
  });
  await runtime.start();
  await runtime.startSubAgent({ message: "go" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  // Both invocations became terminal while the run was still active: the first
  // completion must not be dropped just because it is not the last one.
  completions = [
    { sessionId: "session-1", nickname: "pikachu", invocationId: "inv-1", status: "completed", text: "first" },
    { sessionId: "session-1", nickname: "pikachu", invocationId: "inv-2", status: "completed", text: "second" }
  ];
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(delivered.map((entry) => entry.invocationId).sort(), ["inv-1", "inv-2"]);
  await runtime.stop();
});

test("watch delivery failures do not poison the dedup key", async () => {
  const worker = fakeWorker();
  worker.sessionStatusBySessionId = async () => ({
    sessionId: "session-1",
    idle: true,
    invocationStatus: "completed",
    createdAt: "2026-08-05T12:00:00.000",
    updatedAt: "2026-08-05T12:00:00.000",
    terminalCompletions: [{ sessionId: "session-1", nickname: "pikachu", invocationId: "inv-1", status: "completed", text: "done" }]
  });
  let calls = 0;
  const runtime = createPiWorkerRuntime({
    worker,
    pollIntervalMs: 1,
    prepareModel: () => ({ model: "model-a", supportsImage: false, reasoning: false }),
    onInvocationCompleted: async () => {
      calls += 1;
      if (calls === 1) throw new Error("delivery_failed");
    }
  });
  await runtime.start();
  await runtime.startSubAgent({ message: "go" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls, 2, "a failed delivery is retried by the next watch poll");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls, 2, "a successful delivery is not delivered again");
  await runtime.stop();
});

test("SubAgent resolves the completion target through the output target resolver", async () => {
  const worker = fakeWorker();
  const captured: unknown[] = [];
  worker.startInvocation = async (body: any) => {
    captured.push(body.messageTarget);
    return { invocationId: "inv-1", sessionId: "session-1", nickname: "pikachu", status: "running" };
  };
  const runtime = createPiWorkerRuntime({ worker, prepareModel: () => ({ model: "model-a", supportsImage: false, reasoning: false }) });
  await runtime.start();
  const tool = createSubAgentTool({
    runtime,
    resolveOutputTarget: () => ({ plugin: "wechat", sessionId: "chat-1", userId: "u1", channelId: "c1" })
  });
  const result = await tool.execute({ id: "call-1", toolName: "SubAgent", input: { action: "spawn", message: "hi" } });
  assert.equal(result.ok, true);
  assert.deepEqual(captured, [{ scope: undefined, plugin: "wechat", sessionId: "chat-1", userId: "u1", channelId: "c1", accountId: undefined }]);
  await runtime.stop();
});

test("SubAgent falls back to externalSession when the resolver is absent", async () => {
  const worker = fakeWorker();
  const captured: unknown[] = [];
  worker.startInvocation = async (body: any) => {
    captured.push(body.messageTarget);
    return { invocationId: "inv-1", sessionId: "session-1", nickname: "pikachu", status: "running" };
  };
  const runtime = createPiWorkerRuntime({ worker, prepareModel: () => ({ model: "model-a", supportsImage: false, reasoning: false }) });
  await runtime.start();
  const tool = createSubAgentTool({ runtime });
  await tool.execute({
    id: "call-1",
    toolName: "SubAgent",
    input: { action: "spawn", message: "hi" },
    requester: { plugin: "feishu", userId: "u9", accountId: "a1", channelId: "ch1" },
    externalSession: { scope: "dm", sessionId: "chat-9" }
  });
  assert.deepEqual(captured, [{ scope: "dm", plugin: "feishu", userId: "u9", accountId: "a1", channelId: "ch1", sessionId: "chat-9" }]);
  await runtime.stop();
});

function fakeWorker(): PiWorkerClient & { lastTool?: unknown } {
  const state = { lastTool: undefined as unknown };
  let snapshot: PiSessionSnapshot = {
    sessionId: "session-1",
    idle: false,
    invocationStatus: "running",
    createdAt: "2026-08-05T12:00:00.000",
    updatedAt: "2026-08-05T12:00:00.000"
  };
  return {
    get lastTool() { return state.lastTool; },
    configure: async () => ({ ok: true }),
    health: async () => health,
    executeTool: async ({ toolName, input }) => {
      state.lastTool = { toolName, input };
      return { ok: true, output: "ok" };
    },
    startInvocation: async () => {
      snapshot = { ...snapshot, idle: false, invocationStatus: "running" };
      return { invocationId: "inv-1", sessionId: "session-1", nickname: "pikachu", status: "running" };
    },
    sendInvocation: async (nickname) => ({ invocationId: "inv-2", sessionId: "session-1", nickname, status: "queued" }),
    listSessions: async () => [],
    sessionMessages: async () => [],
    subAgentStatus: async () => ({ updatedAt: "2026-08-05T12:00:00.000", messages: 0, status: snapshot.invocationStatus ?? "completed" }),
    sessionStatus: async () => {
      if (snapshot.invocationStatus === "running") {
        snapshot = { ...snapshot, idle: true, invocationStatus: "completed", lastInvocation: { sessionId: "session-1", nickname: "pikachu", invocationId: "inv-1", status: "completed", text: "done" } };
      }
      return snapshot;
    },
    waitSession: async () => {
      if (snapshot.invocationStatus === "running") return { status: "running" as const };
      if (snapshot.invocationStatus === "completed") return { status: "completed" as const, message: { role: "assistant" as const, content: "done" } };
      return { status: snapshot.invocationStatus as Exclude<PiInvocationStatus, "queued" | "running" | "completed"> };
    },
    sessionStatusBySessionId: async () => {
      if (snapshot.invocationStatus === "running") {
        snapshot = { ...snapshot, idle: true, invocationStatus: "completed", lastInvocation: { sessionId: "session-1", nickname: "pikachu", invocationId: "inv-1", status: "completed", text: "done" } };
      }
      return snapshot;
    },
    resultSession: async () => {
      if (snapshot.invocationStatus === "running") return { status: "running" as const };
      if (snapshot.invocationStatus === "completed") return { status: "completed" as const, message: { role: "assistant" as const, content: "done" } };
      return { status: snapshot.invocationStatus as Exclude<PiInvocationStatus, "queued" | "running" | "completed"> };
    },
    cancelSession: async () => "cancelled" as const,
    forkSession: async () => ({ sessionId: "session-2", nickname: "raichu" }),
    previewSession: async () => ({ sessionId: "preview-1", systemPrompt: "preview" })
  };
}
