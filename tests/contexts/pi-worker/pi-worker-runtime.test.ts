import test from "node:test";
import assert from "node:assert/strict";
import { createPiWorkerRuntime, type PiInvocationCompletion, type PiSessionSnapshot, type PiToolDefinition, type PiWorkerClient, type PiWorkerHealth } from "../../../src/contexts/pi-worker/src/index.js";
import { createFileTools } from "../../../src/capabilities/tools/file/src/index.js";
import { createShellTools } from "../../../src/capabilities/tools/shell/src/index.js";
import { createSubAgentTool } from "../../../src/capabilities/tools/subagent/src/index.js";

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
  const runtime = createPiWorkerRuntime({ worker, reconcileOnStart: false, prepareModel: () => ({ model: "model-a", supportsImage: false, reasoning: false }) });
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
  const runtime = createPiWorkerRuntime({ worker, reconcileOnStart: false, prepareModel: () => ({ model: "model-a", supportsImage: false, reasoning: false }) });
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
  const runtime = createPiWorkerRuntime({ worker, reconcileOnStart: false, prepareModel: () => ({ model: "model-a", supportsImage: false, reasoning: false }) });
  await runtime.start();
  const fileTool = createFileTools({ piWorker: runtime });
  const shellTool = createShellTools({ runtime });

  const fileResult = await fileTool.execute({ id: "call-file-text", toolName: "Read", input: { path: "/tmp/env" } });
  const shellResult = await shellTool.execute({ id: "call-shell-text", toolName: "Bash", input: { command: "env" } });

  assert.equal(fileResult.output, "test\nalice\nPI_MAX_CONCURRENCY=2");
  assert.equal(shellResult.output, "stdout");
  await runtime.stop();
});

test("SubAgent start returns the Pi session and invocation ids without waiting for completion", async () => {
  const worker = fakeWorker();
  const runtime = createPiWorkerRuntime({ worker, reconcileOnStart: false, pollIntervalMs: 10_000, prepareModel: () => ({ model: "model-a", supportsImage: false, reasoning: false }) });
  await runtime.start();
  const tool = createSubAgentTool({ runtime });
  const result = await tool.execute({ id: "call-2", toolName: "SubAgent", input: { action: "start", message: "inspect the workspace" } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.output, { invocationId: "inv-1", sessionId: "session-1", status: "running" });
  await runtime.stop();
});

test("Pi image tool results become image follow-up attachments for multimodal Chat", async () => {
  const worker = fakeWorker();
  worker.executeTool = async () => ({ ok: true, content: [{ type: "text", text: "photo" }, { type: "image", path: "/home/alice/photo.png", mime: "image/png" }] });
  const runtime = createPiWorkerRuntime({ worker, reconcileOnStart: false, prepareModel: () => ({ model: "model-a", supportsImage: false, reasoning: false }) });
  await runtime.start();
  const tool = createFileTools({ piWorker: runtime, resolveImagePath: (value) => `/host${value}` });
  const result = await tool.execute({ id: "call-image", toolName: "Read", input: {} }, { llmCapabilities: { supportsImage: true } });
  assert.equal(result.output, "photo");
  assert.deepEqual(result.llmFollowupAttachments, [{ kind: "image", path: "/host/home/alice/photo.png", mime: "image/png" }]);
  await runtime.stop();
});

test("terminal invocations notify once with final text", async () => {
  const worker = fakeWorker();
  const delivered: PiInvocationCompletion[] = [];
  const runtime = createPiWorkerRuntime({
    worker,
    reconcileOnStart: false,
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

test("reconcile re-delivers terminal invocations idempotently", async () => {
  const worker = fakeWorker();
  worker.reconcileInvocations = async () => ([
    { sessionId: "session-1", invocationId: "inv-1", status: "completed", text: "done", messageTarget: { plugin: "wechat", sessionId: "chat" } }
  ]);
  const delivered: PiInvocationCompletion[] = [];
  const runtime = createPiWorkerRuntime({
    worker,
    reconcileOnStart: false,
    prepareModel: () => ({ model: "model-a", supportsImage: false, reasoning: false }),
    onInvocationCompleted: (completion) => { delivered.push(completion); }
  });
  await runtime.start();
  await runtime.reconcileInvocations();
  await runtime.reconcileInvocations();
  assert.equal(delivered.length, 1);
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
    reconcileOnStart: false,
    prepareModel: () => ({ model: "model-a", supportsImage: false, reasoning: false }),
    refreshAuthorization: async () => { order.push("worker"); gen = "b"; },
    refreshToolRegistry: () => { order.push("refresh"); capturedDefinitions = runtime.toolDefinitions(); }
  });
  await runtime.start();
  await runtime.refresh("wake");
  assert.equal(capturedDefinitions[0].inputSchema.gen, "b");
  // start() 先做一次初始握手, refresh("wake") 再做一次强制握手。
  assert.deepEqual(order, ["worker", "worker", "refresh"]);
  await runtime.stop();
});

test("refresh fails when the tool registry refresh fails", async () => {
  const worker = fakeWorker();
  const runtime = createPiWorkerRuntime({
    worker,
    reconcileOnStart: false,
    prepareModel: () => ({ model: "model-a", supportsImage: false, reasoning: false }),
    refreshToolRegistry: () => { throw new Error("pi_tool_registry_refresh_failed"); }
  });
  await assert.rejects(runtime.refresh("wake"), /pi_tool_registry_refresh_failed/);
  await runtime.stop();
});

test("watch delivers every terminal invocation, not only the latest", async () => {
  const worker = fakeWorker();
  let completions: PiInvocationCompletion[] = [
    { sessionId: "session-1", invocationId: "inv-1", status: "completed", text: "first" }
  ];
  worker.sessionStatus = async () => ({
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
    reconcileOnStart: false,
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
    { sessionId: "session-1", invocationId: "inv-1", status: "completed", text: "first" },
    { sessionId: "session-1", invocationId: "inv-2", status: "completed", text: "second" }
  ];
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(delivered.map((entry) => entry.invocationId).sort(), ["inv-1", "inv-2"]);
  await runtime.stop();
});

test("SubAgent hold pairs one-for-one with running invocations", async () => {
  const worker = fakeWorker();
  const holds = { acquired: 0, released: 0 };
  const runtime = createPiWorkerRuntime({
    worker,
    reconcileOnStart: false,
    pollIntervalMs: 10_000,
    prepareModel: () => ({ model: "model-a", supportsImage: false, reasoning: false })
  });
  await runtime.start();
  const tool = createSubAgentTool({
    runtime,
    agentState: {
      acquireSubAgentHold() { holds.acquired += 1; },
      releaseSubAgentHold() { holds.released += 1; }
    }
  });

  await tool.execute({ id: "call-1", toolName: "SubAgent", input: { action: "start", message: "first" } });
  assert.deepEqual(holds, { acquired: 1, released: 0 });
  // Second invocation on the same session (send while the first is still active).
  await tool.execute({ id: "call-2", toolName: "SubAgent", input: { action: "send", sessionId: "session-1", message: "more" } });
  assert.deepEqual(holds, { acquired: 2, released: 0 });

  // First invocation completes: exactly one hold is released, the other stays.
  worker.reconcileInvocations = async () => ([
    { sessionId: "session-1", invocationId: "inv-1", status: "completed", text: "first" }
  ]);
  await runtime.reconcileInvocations();
  assert.deepEqual(holds, { acquired: 2, released: 1 });

  // Second invocation completes: the remaining hold is released.
  worker.reconcileInvocations = async () => ([
    { sessionId: "session-1", invocationId: "inv-2", status: "completed", text: "second" }
  ]);
  await runtime.reconcileInvocations();
  assert.deepEqual(holds, { acquired: 2, released: 2 });
  await runtime.stop();
});

test("delivery failures do not poison the dedup key", async () => {
  const worker = fakeWorker();
  worker.reconcileInvocations = async () => ([
    { sessionId: "session-1", invocationId: "inv-1", status: "completed", text: "done" }
  ]);
  let calls = 0;
  const runtime = createPiWorkerRuntime({
    worker,
    reconcileOnStart: false,
    prepareModel: () => ({ model: "model-a", supportsImage: false, reasoning: false }),
    onInvocationCompleted: async () => {
      calls += 1;
      if (calls === 1) throw new Error("delivery_failed");
    }
  });
  await runtime.start();
  await assert.rejects(runtime.reconcileInvocations(), /delivery_failed/);
  await runtime.reconcileInvocations();
  assert.equal(calls, 2);
  await runtime.reconcileInvocations();
  assert.equal(calls, 2);
  await runtime.stop();
});

test("SubAgent resolves the completion target through the output target resolver", async () => {
  const worker = fakeWorker();
  const captured: unknown[] = [];
  worker.startInvocation = async (body: any) => {
    captured.push(body.messageTarget);
    return { invocationId: "inv-1", sessionId: "session-1", status: "running" };
  };
  const runtime = createPiWorkerRuntime({ worker, reconcileOnStart: false, prepareModel: () => ({ model: "model-a", supportsImage: false, reasoning: false }) });
  await runtime.start();
  const tool = createSubAgentTool({
    runtime,
    resolveOutputTarget: () => ({ plugin: "wechat", sessionId: "chat-1", userId: "u1", channelId: "c1" })
  });
  const result = await tool.execute({ id: "call-1", toolName: "SubAgent", input: { action: "start", message: "hi" } });
  assert.equal(result.ok, true);
  assert.deepEqual(captured, [{ scope: undefined, plugin: "wechat", sessionId: "chat-1", userId: "u1", channelId: "c1", accountId: undefined }]);
  await runtime.stop();
});

test("SubAgent falls back to externalSession when the resolver is absent", async () => {
  const worker = fakeWorker();
  const captured: unknown[] = [];
  worker.startInvocation = async (body: any) => {
    captured.push(body.messageTarget);
    return { invocationId: "inv-1", sessionId: "session-1", status: "running" };
  };
  const runtime = createPiWorkerRuntime({ worker, reconcileOnStart: false, prepareModel: () => ({ model: "model-a", supportsImage: false, reasoning: false }) });
  await runtime.start();
  const tool = createSubAgentTool({ runtime });
  await tool.execute({
    id: "call-1",
    toolName: "SubAgent",
    input: { action: "start", message: "hi" },
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
      return { invocationId: "inv-1", sessionId: "session-1", status: "running" };
    },
    sendInvocation: async (sessionId) => ({ invocationId: "inv-2", sessionId, status: "queued" }),
    listSessions: async () => [],
    readSession: async () => ({ sessionId: "session-1", idle: true, invocationStatus: "completed" }),
    sessionStatus: async () => {
      if (snapshot.invocationStatus === "running") {
        snapshot = { ...snapshot, idle: true, invocationStatus: "completed", lastInvocation: { sessionId: "session-1", invocationId: "inv-1", status: "completed", text: "done" } };
      }
      return snapshot;
    },
    waitSession: async () => snapshot,
    cancelSession: async () => ({ ...snapshot, idle: true, invocationStatus: "aborted" }),
    forkSession: async () => ({ sessionId: "session-2" }),
    previewSession: async () => ({ sessionId: "preview-1", systemPrompt: "preview" }),
    reconcileInvocations: async () => []
  };
}
