import test from "node:test";
import assert from "node:assert/strict";
import { createPiSandboxRuntime, type PiSession, type PiWorkerClient, type PiWorkerHealth } from "../../../src/contexts/pi-sandbox/src/index.js";
import { createPiToolAdapter } from "../../../src/capabilities/tools/pi/src/pi-tool-adapter.js";
import { createSubAgentTool } from "../../../src/capabilities/tools/pi/src/subagent-tool.js";

const health: PiWorkerHealth = {
  ready: true,
  version: "1.2.3",
  toolDefinitionGeneration: "generation-a",
  cwd: "/alice",
  relayReachable: true,
  toolDefinitions: [
    { name: "read", description: "native read", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
    { name: "write", description: "native write", inputSchema: { type: "object" } },
    { name: "edit", description: "native edit", inputSchema: { type: "object" } },
    { name: "bash", description: "native bash", inputSchema: { type: "object" } },
    { name: "grep", description: "not exposed", inputSchema: { type: "object" } }
  ]
};

test("Pi tool adapter exposes current worker definitions with only name casing changed", async () => {
  const worker = fakeWorker();
  const runtime = createPiSandboxRuntime({ worker, reconcileOnStart: false });
  await runtime.start();
  const tool = createPiToolAdapter({ runtime });
  assert.deepEqual(tool.listTools(), [
    { name: "Read", description: "native read", inputSchema: health.toolDefinitions[0].inputSchema },
    { name: "Write", description: "native write", inputSchema: health.toolDefinitions[1].inputSchema },
    { name: "Edit", description: "native edit", inputSchema: health.toolDefinitions[2].inputSchema },
    { name: "Bash", description: "native bash", inputSchema: health.toolDefinitions[3].inputSchema }
  ]);
  const result = await tool.execute({ id: "call-1", toolName: "Read", input: { path: "a.txt" } });
  assert.equal(result.ok, true);
  assert.deepEqual(worker.lastTool, { toolName: "read", input: { path: "a.txt" } });
});

test("SubAgent start returns the Pi session id without waiting for completion", async () => {
  const worker = fakeWorker();
  const runtime = createPiSandboxRuntime({ worker, reconcileOnStart: false, pollIntervalMs: 10_000 });
  const tool = createSubAgentTool({ runtime });
  const result = await tool.execute({ id: "call-2", toolName: "SubAgent", input: { action: "start", task: "inspect the workspace" } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.output, { sessionId: "session-1", status: "queued" });
  await runtime.stop();
});

test("Pi image tool results become image follow-up attachments for multimodal Chat", async () => {
  const worker = fakeWorker();
  worker.executeTool = async () => ({ ok: true, content: [{ type: "text", text: "photo" }, { type: "image", path: "/alice/photo.png", mime: "image/png" }] });
  const runtime = createPiSandboxRuntime({ worker, reconcileOnStart: false });
  await runtime.start();
  const tool = createPiToolAdapter({ runtime, resolveImagePath: (value) => `/host${value}` });
  const result = await tool.execute({ id: "call-image", toolName: "Read", input: {} }, { llmCapabilities: { supportsImage: true } });
  assert.deepEqual(result.llmFollowupAttachments, [{ kind: "image", path: "/host/alice/photo.png", mime: "image/png" }]);
  await runtime.stop();
});

test("terminal sessions notify once and mark delivery after ingestion succeeds", async () => {
  const worker = fakeWorker();
  const delivered: string[] = [];
  const runtime = createPiSandboxRuntime({ worker, reconcileOnStart: false, pollIntervalMs: 1, onTerminal: (session) => { delivered.push(session.terminalResult ?? ""); } });
  await runtime.start();
  await runtime.startSubAgent({ task: "finish" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(delivered, ["done"]);
  assert.deepEqual(worker.delivered, ["session-1"]);
  await runtime.stop();
});

function fakeWorker(): PiWorkerClient & { lastTool?: unknown; delivered: string[] } {
  let session: PiSession = {
    sessionId: "session-1",
    status: "queued",
    task: "",
    createdAt: "2026-08-05T12:00:00.000",
    updatedAt: "2026-08-05T12:00:00.000"
  };
  const state = { lastTool: undefined as unknown, delivered: [] as string[] };
  return {
    get lastTool() { return state.lastTool; },
    get delivered() { return state.delivered; },
    health: async () => health,
    executeTool: async ({ toolName, input }) => {
      state.lastTool = { toolName, input };
      return { ok: true, output: "ok" };
    },
    createSession: async ({ task }) => {
      session = { ...session, task, status: "queued" };
      return { sessionId: session.sessionId, status: session.status };
    },
    startSession: async () => ({ sessionId: session.sessionId, status: session.status }),
    previewSession: async ({ sessionId }) => ({ sessionId, systemPrompt: "preview" }),
    getSession: async () => {
      if (session.status === "queued") session = { ...session, status: "completed", terminalResult: "done" };
      return session;
    },
    listSessions: async () => [],
    listSessionEvents: async () => ({ events: [] }),
    cancelSession: async () => session,
    markInterrupted: async () => ({ ...session, status: "interrupted" }),
    markCompletionDelivered: async (sessionId) => {
      state.delivered.push(sessionId);
      session = { ...session, completionDelivered: true };
      return session;
    }
  };
}
