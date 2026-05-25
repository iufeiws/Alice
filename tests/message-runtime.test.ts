import { test } from "node:test";
import assert from "node:assert/strict";
import { createMessageRuntime } from "../apps/api/src/message-runtime.js";
import { createAliceStore, type StoredMessageLog } from "../packages/storage/src/sqlite-store.js";
import type { AgentEvent, AgentOutput } from "../packages/types/src/index.js";

const fs = await import("node:fs");
const path = await import("node:path");

test("message runtime sends one LLM request for pending inbound logs and marks them processed", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime"), "alice.sqlite"));
  const coreInputs: AgentEvent[] = [];
  const outputs: AgentOutput[] = [textOutput("session-1", "ok")];
  const runtime = createMessageRuntime({
    getDelayMs: () => 10,
    store,
    core: {
      async handleEvent(event) {
        coreInputs.push(event);
        return outputs;
      }
    },
    outputRouter: {
      async sendAll() {}
    },
    appendLog() {},
    appendMessageLog(input) {
      return store.insertMessageLog({ time: new Date().toISOString(), ...input });
    }
  });

  runtime.ingestEvent(textEvent("session-1", "om_1", "hello"));
  runtime.ingestEvent(textEvent("session-1", "om_2", "world"));
  await waitFor(() => coreInputs.length === 1);

  assert.equal(coreInputs[0].payload.kind, "text");
  assert.ok(coreInputs[0].payload.kind === "text" && coreInputs[0].payload.text.includes("hello\nworld"));
  assert.equal(store.listUnprocessedCoreMessagesForConversation("session-1", 10).length, 0);
  assert.equal(store.listMessagesForConversation("session-1", 10).filter((entry) => entry.direction === "outbound").length, 1);
});

test("message runtime uses agent state delay and records inbound activity", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime-state-delay"), "alice.sqlite"));
  const coreInputs: AgentEvent[] = [];
  let inboundActivity = 0;
  const runtime = createMessageRuntime({
    getDelayMs: () => 10_000,
    agentState: {
      canReplyToInbound: () => true,
      canRunHeartbeat: () => true,
      tick() {
        return {
          state: "waiting",
          intimacy: 50,
          updatedAt: "2026-05-24T00:00:00.000Z",
          responseDelayMs: 10
        };
      },
      getInboundDelayMs: () => 10,
      onChange: () => () => {},
      noteInboundMessage() {
        inboundActivity += 1;
        return {
          state: "waiting",
          intimacy: 50,
          updatedAt: "2026-05-24T00:00:00.000Z",
          responseDelayMs: 10
        };
      }
    },
    store,
    core: {
      async handleEvent(event) {
        coreInputs.push(event);
        return [textOutput("session-1", "ok")];
      }
    },
    outputRouter: {
      async sendAll() {}
    },
    appendLog() {},
    appendMessageLog(input) {
      return store.insertMessageLog({ time: new Date().toISOString(), ...input });
    }
  });

  runtime.ingestEvent(textEvent("session-1", "om_1", "hello"));
  await waitFor(() => coreInputs.length === 1);

  assert.equal(inboundActivity, 1);
});

test("message runtime heartbeat waits until latest pending message exceeds saved state delay", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime-heartbeat-delay"), "alice.sqlite"));
  const coreInputs: AgentEvent[] = [];
  let current = new Date("2026-05-24T00:00:00.000Z");
  const runtime = createMessageRuntime({
    getDelayMs: () => 10_000,
    getHeartbeatIntervalMs: () => 10,
    now: () => current,
    agentState: {
      canReplyToInbound: () => true,
      canRunHeartbeat: () => true,
      tick() {
        return {
          state: "waiting",
          intimacy: 50,
          updatedAt: current.toISOString(),
          responseDelayMs: 10_000
        };
      },
      getInboundDelayMs: () => 10_000,
      onChange: () => () => {},
      noteInboundMessage() {
        return {
          state: "waiting",
          intimacy: 50,
          updatedAt: current.toISOString(),
          responseDelayMs: 10_000
        };
      }
    },
    store,
    core: {
      async handleEvent(event) {
        coreInputs.push(event);
        return [textOutput("session-1", "ok")];
      }
    },
    outputRouter: {
      async sendAll() {}
    },
    appendLog() {},
    appendMessageLog(input) {
      return store.insertMessageLog({ time: new Date().toISOString(), ...input });
    }
  });

  runtime.ingestEvent(textEventAt("session-1", "om_1", "hello", current.toISOString()));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(coreInputs.length, 0);

  current = new Date("2026-05-24T00:00:10.000Z");
  await waitFor(() => coreInputs.length === 1);
});

test("message runtime heartbeat does not count delay while state cannot reply", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime-away-gate"), "alice.sqlite"));
  const coreInputs: AgentEvent[] = [];
  let canReply = false;
  let onStateChange: (() => void) | undefined;
  const runtime = createMessageRuntime({
    getDelayMs: () => 10,
    getHeartbeatIntervalMs: () => 10,
    now: () => new Date("2026-05-24T01:00:00.000Z"),
    agentState: {
      canReplyToInbound: () => canReply,
      canRunHeartbeat: () => canReply,
      tick() {
        return {
          state: canReply ? "waiting" : "away",
          intimacy: 50,
          updatedAt: "2026-05-24T01:00:00.000Z",
          responseDelayMs: 10
        };
      },
      getInboundDelayMs: () => 10,
      onChange(listener) {
        onStateChange = () => listener({
          state: canReply ? "waiting" : "away",
          intimacy: 50,
          updatedAt: "2026-05-24T01:00:00.000Z",
          responseDelayMs: 10
        });
        return () => {
          onStateChange = undefined;
        };
      },
      noteInboundMessage() {
        return {
          state: canReply ? "waiting" : "away",
          intimacy: 50,
          updatedAt: "2026-05-24T01:00:00.000Z",
          responseDelayMs: 10
        };
      }
    },
    store,
    core: {
      async handleEvent(event) {
        coreInputs.push(event);
        return [textOutput("session-1", "ok")];
      }
    },
    outputRouter: {
      async sendAll() {}
    },
    appendLog() {},
    appendMessageLog(input) {
      return store.insertMessageLog({ time: new Date().toISOString(), ...input });
    }
  });

  runtime.ingestEvent(textEventAt("session-1", "om_1", "hello", "2026-05-24T00:00:00.000Z"));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(coreInputs.length, 0);

  canReply = true;
  onStateChange?.();
  await waitFor(() => coreInputs.length === 1);
});

test("message runtime flushAll stops heartbeat without force-processing pending inbound", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime-flush-gated"), "alice.sqlite"));
  const coreInputs: AgentEvent[] = [];
  const runtime = createMessageRuntime({
    getDelayMs: () => 10,
    getHeartbeatIntervalMs: () => 10,
    now: () => new Date("2026-05-24T01:00:00.000Z"),
    agentState: {
      canReplyToInbound: () => false,
      canRunHeartbeat: () => false,
      tick() {
        return {
          state: "sleeping",
          intimacy: 50,
          updatedAt: "2026-05-24T01:00:00.000Z",
          responseDelayMs: 10
        };
      },
      getInboundDelayMs: () => 10,
      onChange: () => () => {},
      noteInboundMessage() {
        return {
          state: "sleeping",
          intimacy: 50,
          updatedAt: "2026-05-24T01:00:00.000Z",
          responseDelayMs: 10
        };
      }
    },
    store,
    core: {
      async handleEvent(event) {
        coreInputs.push(event);
        return [textOutput("session-1", "ok")];
      }
    },
    outputRouter: {
      async sendAll() {}
    },
    appendLog() {},
    appendMessageLog(input) {
      return store.insertMessageLog({ time: new Date().toISOString(), ...input });
    }
  });

  runtime.ingestEvent(textEventAt("session-1", "om_1", "hello", "2026-05-24T00:00:00.000Z"));
  await runtime.flushAll();

  assert.equal(coreInputs.length, 0);
  assert.equal(store.listUnprocessedCoreMessagesForConversation("session-1", 10).length, 1);
});

test("message runtime keeps inbound unprocessed when handling fails", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime-fail"), "alice.sqlite"));
  const runtime = createMessageRuntime({
    getDelayMs: () => 10,
    store,
    core: {
      async handleEvent() {
        throw new Error("llm failed");
      }
    },
    outputRouter: {
      async sendAll() {}
    },
    appendLog() {},
    appendMessageLog(input) {
      return store.insertMessageLog({ time: new Date().toISOString(), ...input });
    }
  });

  runtime.ingestEvent(textEvent("session-1", "om_1", "hello"));
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(store.listUnprocessedCoreMessagesForConversation("session-1", 10).length, 1);
});

test("message runtime can recover pending sessions from storage", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime-recover"), "alice.sqlite"));
  store.upsertInboundMessage({
    plugin: "feishu",
    externalMessageId: "om_1",
    conversationId: "session-1",
    senderId: "user",
    contentType: "text",
    contentText: "recover me",
    createdAt: "2026-05-24T00:00:00.000Z"
  });
  const coreInputs: AgentEvent[] = [];
  const runtime = createMessageRuntime({
    getDelayMs: () => 10,
    store,
    core: {
      async handleEvent(event) {
        coreInputs.push(event);
        return [textOutput("session-1", "ok")];
      }
    },
    outputRouter: {
      async sendAll() {}
    },
    appendLog() {},
    appendMessageLog(input) {
      return store.insertMessageLog({ time: new Date().toISOString(), ...input });
    }
  });

  runtime.recoverPendingSessions();
  await waitFor(() => coreInputs.length === 1);

  assert.equal(coreInputs[0].meta.replyTo, "om_1");
  assert.equal(store.listUnprocessedCoreMessagesForConversation("session-1", 10).length, 0);
});

test("message runtime records lifecycle events as message state updates without core handling", async () => {
  const store = createAliceStore(path.join(makeTempDir("runtime-lifecycle"), "alice.sqlite"));
  let handled = 0;
  const runtime = createMessageRuntime({
    getDelayMs: () => 10,
    store,
    core: {
      async handleEvent() {
        handled += 1;
        return [];
      }
    },
    outputRouter: {
      async sendAll() {}
    },
    appendLog() {},
    appendMessageLog(input) {
      return store.insertMessageLog({ time: new Date().toISOString(), ...input });
    }
  });

  runtime.ingestEvent(textEvent("session-1", "om_1", "hello"));
  await waitFor(() => handled === 1);
  runtime.ingestLifecycle({
    kind: "reaction.created",
    plugin: "feishu",
    externalMessageId: "om_1",
    actorId: "ou_other",
    emoji: "thumbsup",
    occurredAt: "2026-05-24T00:01:00.000Z"
  });
  runtime.ingestLifecycle({
    kind: "message.read",
    plugin: "feishu",
    externalMessageId: "om_1",
    occurredAt: "2026-05-24T00:02:00.000Z"
  });
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(handled, 1);
  const message = store.listMessagesForConversation("session-1", 10).find((entry) => entry.externalMessageId === "om_1");
  assert.ok(message);
  assert.equal(Boolean(message.isRead), true);
  assert.deepEqual(JSON.parse(message.reactionsJson), { thumbsup: { count: 1, users: ["ou_other"] } });
});

function textEvent(sessionId: string, rawMessageId: string, text: string): AgentEvent {
  return textEventAt(sessionId, rawMessageId, text, "2026-05-24T00:00:00.000Z");
}

function textEventAt(sessionId: string, rawMessageId: string, text: string, receivedAt: string): AgentEvent {
  return {
    id: `evt_${rawMessageId}`,
    source: {
      plugin: "feishu",
      accountId: "main",
      channelId: "chat",
      userId: "user",
      rawMessageId
    },
    session: {
      scope: "dm",
      sessionId
    },
    type: "message.text",
    payload: { kind: "text", text },
    meta: {
      receivedAt,
      replyTo: rawMessageId
    }
  };
}

function textOutput(sessionId: string, text: string): AgentOutput {
  return {
    id: "out_1",
    target: {
      plugin: "feishu",
      channelId: "chat",
      sessionId
    },
    content: { kind: "text", text },
    meta: {
      createdAt: "2026-05-24T00:00:00.000Z",
      urgency: "normal"
    }
  };
}

function makeTempDir(name: string): string {
  const dir = path.join("/tmp", `alice-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("condition was not met before timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
