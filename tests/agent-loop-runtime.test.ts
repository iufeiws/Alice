import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentHeartbeatRuntime } from "../src/contexts/agent-loop/src/runtime/agent-heartbeat-runtime.js";
import { createAgentLoopRuntime } from "../src/contexts/agent-loop/src/runtime/agent-loop-runtime.js";
import type { AgentEvent } from "../src/contexts/agent-loop/src/contracts/agent-contracts.js";

test("agent loop runtime runs chat requests through configured runner and exposes active main session", async () => {
  const runtime = createAgentLoopRuntime();
  const observedGenerations: number[] = [];
  runtime.setRunners({
    prepareChat({ sessionId }) {
      const active = runtime.getActiveMainLLMSession();
      assert.equal(active?.id, sessionId);
      assert.equal(active?.agentId, "chat");
      assert.equal(active?.phase, "running");
      observedGenerations.push(active.generation);
      return [{
        id: "out_1",
        target: { plugin: "test", sessionId },
        content: { kind: "text", text: "ok" },
        meta: { createdAt: "2026-06-12T00:00:00.000Z", urgency: "normal" }
      }];
    }
  });

  const result = await runtime.requestRun({
    kind: "chat",
    sessionId: "session-1",
    reason: "test",
    event: textEvent("session-1")
  });

  assert.equal(result.started, true);
  assert.equal(result.outputs.length, 1);
  assert.deepEqual(observedGenerations, [1]);
  assert.equal(runtime.getActiveMainLLMSession()?.phase, "idle");
});

test("agent loop runtime rejects overlapping runs", async () => {
  let releaseRun: (() => void) | undefined;
  const runtime = createAgentLoopRuntime({
    prepareTalk() {
      return new Promise((resolve) => {
        releaseRun = () => resolve({
          prepare: () => [],
          complete: () => []
        });
      });
    }
  });

  const first = runtime.requestRun({ kind: "talk", sessionId: "talk-1", reason: "first" });
  assert.equal(runtime.isRunning(), true);
  const second = await runtime.requestRun({ kind: "talk", sessionId: "talk-1", reason: "second" });
  assert.deepEqual(second, { started: false, outputs: [] });
  releaseRun?.();
  assert.deepEqual(await first, { started: true, outputs: [] });
});

test("agent heartbeat forced run owns manual session fallback", async () => {
  let pendingSessionIds = ["session-pending"];
  let pendingProcessed = 0;
  let manualProcessed = 0;
  const heartbeat = createAgentHeartbeatRuntime({
    getIntervalMs: () => 1000,
    appendLog: () => {},
    tasks: {
      canRunHeartbeat: () => true,
      hasPendingUserMessages: () => pendingSessionIds.length > 0,
      runGeneratedSession: async () => false,
      runManualSession: async () => {
        manualProcessed += 1;
        return true;
      },
      getPendingSessionIds: () => pendingSessionIds,
      isProcessingSession: () => false,
      beginProcessingSession: () => {},
      finishProcessingSession: () => {},
      getPendingMessageCount: (sessionId) => sessionId === "session-pending" ? 1 : 0,
      shouldProcessPendingSession: () => true,
      markSessionNotPending: (sessionId) => {
        pendingSessionIds = pendingSessionIds.filter((id) => id !== sessionId);
      },
      processPendingSession: async () => {
        pendingProcessed += 1;
      },
      appendLog: () => {}
    }
  });

  assert.equal(await heartbeat.run({ force: true, runManualSessionWhenIdle: true }), 1);
  assert.equal(pendingProcessed, 1);
  assert.equal(manualProcessed, 0);

  pendingSessionIds = [];
  assert.equal(await heartbeat.run({ force: true, runManualSessionWhenIdle: true }), 1);
  assert.equal(manualProcessed, 1);
});

test("agent loop runtime exposes active llm session pointer operations", () => {
  const runtime = createAgentLoopRuntime();
  const calls: string[] = [];
  const transcript = { messages: [{ role: "user", content: "hello" }] };
  runtime.setActiveLLMSessionRuntime({
    ensureActiveLLMSession(time, agentId) {
      calls.push(`ensure:${agentId ?? "chat"}:${time}`);
      return { id: `${agentId ?? "chat"}-session` };
    },
    createTalkLLMSession(time) {
      calls.push(`create:${time}`);
      return { id: "talk-session" };
    },
    noteActiveLLMRequest(_entry, agentId) {
      calls.push(`note-request:${agentId ?? "chat"}`);
    },
    noteActiveLLMResponse() {
      calls.push("note-response");
    },
    isActiveTalkLLMSession(sessionId) {
      calls.push(`is-talk:${sessionId}`);
      return sessionId === "talk-session";
    },
    loadActiveLLMSessionTranscript() {
      calls.push("load");
      return transcript;
    },
    updateActiveLLMSessionTranscript(session) {
      calls.push(`update-chat:${(session as { id: string }).id}`);
    },
    updateActiveTalkLLMSessionTranscript(session) {
      calls.push(`update-talk:${(session as { id: string }).id}`);
    },
    rewriteActiveTalkLLMSessionFromRuntime(sessionId) {
      calls.push(`rewrite-talk:${sessionId}`);
    },
    clearActiveLLMSession(reason) {
      calls.push(`clear:${String(reason)}`);
    },
    getActiveLLMSessionSnapshot() {
      calls.push("snapshot");
      return { id: "active" };
    }
  });

  assert.deepEqual(runtime.ensureActiveLLMSession("2026-06-12T00:00:00.000", "chat").id, "chat-session");
  assert.deepEqual(runtime.createTalkLLMSession("2026-06-12T00:00:00.000").id, "talk-session");
  runtime.noteActiveLLMRequest({ id: "request" }, "talk");
  runtime.noteActiveLLMResponse({ id: "response" });
  assert.equal(runtime.isActiveTalkLLMSession("talk-session"), true);
  assert.equal(runtime.loadActiveLLMSessionTranscript(), transcript);
  runtime.updateActiveLLMSessionTranscript({ id: "chat-session" });
  runtime.updateActiveTalkLLMSessionTranscript({ id: "talk-session" });
  runtime.rewriteActiveTalkLLMSessionFromRuntime("talk-session");
  runtime.clearActiveLLMSession("admin_clear");
  assert.deepEqual(runtime.getActiveLLMSessionSnapshot(), { id: "active" });
  assert.deepEqual(calls, [
    "ensure:chat:2026-06-12T00:00:00.000",
    "create:2026-06-12T00:00:00.000",
    "note-request:talk",
    "note-response",
    "is-talk:talk-session",
    "load",
    "update-chat:chat-session",
    "update-talk:talk-session",
    "rewrite-talk:talk-session",
    "clear:admin_clear",
    "snapshot"
  ]);
});

test("agent loop runtime stores loop session state by kind", () => {
  const runtime = createAgentLoopRuntime();
  const chatState = { id: "chat-state" };
  const talkState = { id: "talk-state" };

  runtime.setLoopSessionState("chat", chatState);
  runtime.setLoopSessionState("talk", talkState);

  assert.equal(runtime.getLoopSessionState("chat"), chatState);
  assert.equal(runtime.getLoopSessionState("talk"), talkState);

  runtime.clearLoopSessionState("chat");
  assert.equal(runtime.getLoopSessionState("chat"), undefined);
  assert.equal(runtime.getLoopSessionState("talk"), talkState);
});

test("agent loop runtime prepares and writes loop session context", async () => {
  const runtime = createAgentLoopRuntime();
  let transcript: any;
  const prepared = await runtime.prepareSessionContext({
    kind: "talk",
    sessionId: "talk-context",
    loadTranscript: () => transcript,
    buildInitialMessages: () => [{ role: "system", content: "prefix" }],
    buildMessagePatch: () => ({ replaceFrom: 1, messages: [{ role: "user", content: "voice turn" }] }),
    updateTranscript(session) {
      transcript = session;
    }
  });

  assert.equal(prepared.prefixMessageCount, 1);
  assert.deepEqual(transcript.messages, [
    { role: "system", content: "prefix" },
    { role: "user", content: "voice turn" }
  ]);
  assert.equal(transcript.staticPromptFingerprint, "talk");
});

test("agent loop runtime appends and writes loop session context", () => {
  const runtime = createAgentLoopRuntime();
  const session = {
    messages: [{ role: "system" as const, content: "prefix" }]
  };
  let written: typeof session | undefined;

  const result = runtime.appendSessionContext({
    session,
    messages: [{ role: "user", content: "new turn" }],
    updateSession(updated) {
      written = updated;
    }
  });

  assert.equal(result.appended, true);
  assert.equal(written, session);
  assert.deepEqual(session.messages, [
    { role: "system", content: "prefix" },
    { role: "user", content: "new turn" }
  ]);
});

test("agent loop runtime sets and clears active session context", () => {
  const runtime = createAgentLoopRuntime();
  let localSession: { id: string } | undefined;

  runtime.setActiveSessionContext({
    kind: "chat",
    session: { id: "chat-session" },
    setLocalSession(session) {
      localSession = session;
    }
  });

  assert.deepEqual(localSession, { id: "chat-session" });
  assert.deepEqual(runtime.getLoopSessionState("chat"), { id: "chat-session" });

  const cleared = runtime.clearActiveSessionContext({
    kind: "chat",
    getLocalSession: () => localSession,
    setLocalSession(session) {
      localSession = session;
    }
  });

  assert.equal(cleared, true);
  assert.equal(localSession, undefined);
  assert.equal(runtime.getLoopSessionState("chat"), undefined);
});

test("agent loop runtime creates active session context", () => {
  const runtime = createAgentLoopRuntime();
  let localSession: { id: string; messages: unknown[] } | undefined;

  const created = runtime.createActiveSessionContext({
    kind: "chat",
    session: { id: "created-chat", messages: [] },
    setLocalSession(session) {
      localSession = session;
    }
  });

  assert.equal(created.id, "created-chat");
  assert.equal(localSession, created);
  assert.equal(runtime.getLoopSessionState("chat"), created);
});

test("agent loop runtime prepares chat session context", async () => {
  const runtime = createAgentLoopRuntime();
  let localSession: { messages: unknown[]; fingerprint: string } | undefined;

  const prepared = await runtime.prepareChatSessionContext({
    buildMessages: () => [{ role: "system", content: "chat prefix" }],
    createSession(messages) {
      return { messages, fingerprint: "chat-fingerprint" };
    },
    setLocalSession(session) {
      localSession = session;
    }
  });

  assert.equal(prepared.session.fingerprint, "chat-fingerprint");
  assert.equal(prepared.messages.length, 1);
  assert.equal(localSession, prepared.session);
  assert.equal(runtime.getLoopSessionState("chat"), prepared.session);
});

test("agent loop runtime ensures chat session context through reset callbacks", async () => {
  const runtime = createAgentLoopRuntime();
  let session: { id: string; expired?: boolean } | undefined = { id: "old", expired: true };
  let pendingMode: { id: string } | undefined;
  const clears: string[] = [];

  const ensured = await runtime.ensureChatSessionContext({
    getSession: () => session,
    getPendingMode: () => pendingMode,
    setPendingMode(mode) {
      pendingMode = mode;
    },
    defaultMode: () => ({ id: "normal" }),
    shouldClearForInitiatedBehavior: () => false,
    isModeExpired: (current) => current.expired === true,
    isHydratedFixedPrefixPendingRebuild: () => false,
    isStaticPromptChanged: () => false,
    shouldResetForTokenPressure: () => false,
    modeFromSession: () => ({ id: "from-old" }),
    clearSession(reason) {
      if (reason) clears.push(reason);
      session = undefined;
      return true;
    },
    prepareSession(mode) {
      session = { id: `new:${mode.id}` };
      return session;
    }
  });

  assert.deepEqual(clears, ["mode_timeout"]);
  assert.deepEqual(ensured, { id: "new:normal" });
  assert.equal(session, ensured);
});

test("agent loop runtime executes prepared chat runs through the function-call loop", async () => {
  const runtime = createAgentLoopRuntime();
  let prepareCalls = 0;
  runtime.setRunners({
    prepareChat({ sessionId }) {
      return {
        prepare() {
          prepareCalls += 1;
          const active = runtime.getActiveMainLLMSession();
          assert.equal(active?.phase, "running");
          assert.equal(active?.id, sessionId);
          return {
            initialMessages: [{ role: "user", content: "hello" }],
            buildRequest({ messages }) {
              return {
                agentId: "chat",
                messages,
                toolNames: []
              };
            },
            async sendRequest() {
              return { message: { role: "assistant", content: "prepared" }, finishReason: "stop" };
            },
            executeTool() {
              throw new Error("unexpected tool call");
            }
          };
        },
        complete(result) {
          assert.equal(result.finalMessage.content, "prepared");
          return [{
            id: "out_prepared",
            target: { plugin: "test", sessionId },
            content: { kind: "text", text: result.finalMessage.content ?? "" },
            meta: { createdAt: "2026-06-12T00:00:00.000Z", urgency: "normal" }
          }];
        }
      };
    }
  });

  const result = await runtime.requestRun({
    kind: "chat",
    sessionId: "session-prepared",
    reason: "test",
    event: textEvent("session-prepared")
  });

  assert.equal(result.started, true);
  assert.equal(prepareCalls, 1);
  assert.equal(result.outputs[0]?.id, "out_prepared");
});

test("standalone agent function-call loop is exported for loop adapters", async () => {
  const { runAgentFunctionCallLoop } = await import("../src/contexts/agent-loop/src/runtime/agent-loop-runtime.js");
  const calls: string[] = [];
  const result = await runAgentFunctionCallLoop({
    initialMessages: [{ role: "user", content: "use tool" }],
    buildRequest({ messages }) {
      return {
        agentId: "chat",
        messages,
        toolNames: ["test_tool"]
      };
    },
    async sendRequest({ round }) {
      if (round === 0) {
        return {
          message: {
            role: "assistant",
            content: "",
            toolCalls: [{
              id: "call_1",
              type: "function",
              function: { name: "test_tool", arguments: "{}" }
            }]
          },
          finishReason: "tool_calls"
        };
      }
      return { message: { role: "assistant", content: "finished" }, finishReason: "stop" };
    },
    executeTool(call) {
      calls.push(call.function.name);
      return {
        message: {
          role: "tool",
          toolCallId: call.id,
          name: call.function.name,
          content: "tool ok"
        }
      };
    }
  });

  assert.deepEqual(calls, ["test_tool"]);
  assert.equal(result.stopReason, "completed");
  assert.equal(result.rounds, 2);
});

function textEvent(sessionId: string): AgentEvent {
  return {
    id: "evt_1",
    type: "message.text",
    source: { plugin: "test", userId: "user-1" },
    session: { scope: "dm", sessionId },
    payload: { kind: "text", text: "hello" },
    meta: { receivedAt: "2026-06-12T00:00:00.000Z" }
  };
}
