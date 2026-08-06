import { test } from "node:test";
import assert from "node:assert/strict";
import { createMessageRuntime } from "../../../src/contexts/conversation-hub/src/application/ingest-channel-message.js";
import { createAliceStore, type AliceStore } from "../../../src/contexts/conversation-hub/src/adapters/sqlite-conversation-store.js";
import type { AgentOutput } from "../../../src/contexts/agent-loop/src/contracts/agent-contracts.js";

const path = await import("node:path");
const os = await import("node:os");

function makeTempDir(name: string): string {
  return path.join(os.tmpdir(), `alice-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function createRuntime(input: { store: AliceStore; sent: AgentOutput[]; noteInboundMessages?: number }) {
  const noteInbound = { count: input.noteInboundMessages ?? 0 };
  const runtime = createMessageRuntime({
    getDelayMs: () => 60_000,
    getHeartbeatIntervalMs: () => 10_000,
    store: input.store,
    chatAgent: {
      async prepareEventRun() {
        return [];
      }
    },
    outputRouter: {
      async sendAll(outputs) {
        input.sent.push(...outputs);
      }
    },
    agentState: {
      canReplyToInbound: () => true,
      canRunHeartbeat: () => true,
      getInboundDelayMs: () => 0,
      getSnapshot: () => ({ state: "waiting" }),
      onChange: () => () => {},
      noteInboundMessage() {
        noteInbound.count += 1;
        return undefined as never;
      },
      tick: () => undefined as never
    } as never,
    appendLog() {},
    appendMessageLog(entry) {
      return input.store.insertMessageLog({ time: new Date().toISOString(), ...entry });
    }
  });
  return { runtime, noteInbound };
}

test("pi completion creates one both message, sends to the full invocation target, and enters Core pending", async () => {
  const store = createAliceStore(path.join(makeTempDir("pi-completion-deliver"), "alice.sqlite"));
  const sent: AgentOutput[] = [];
  const { runtime, noteInbound } = createRuntime({ store, sent });

  await runtime.deliverPiInvocationCompletion({
    plugin: "feishu",
    conversationId: "oc_chat_1",
    piSessionId: "pi-session-1",
    piInvocationId: "pi-inv-1",
    text: "subagent finished",
    senderName: "Alice",
    accountId: "main",
    channelId: "oc_chat_1",
    userId: "ou_user_1"
  });

  const messages = store.listMessagesForConversation("oc_chat_1", 10);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].direction, "both");
  assert.equal(messages[0].senderRole, "user");
  assert.equal(messages[0].contentText, "subagent finished");
  assert.equal(messages[0].status, "sent");

  assert.equal(sent.length, 1);
  assert.equal(sent[0].content.kind, "text");
  assert.equal(sent[0].content.text, "<-subagent finished->");
  assert.deepEqual(sent[0].target, {
    plugin: "feishu",
    accountId: "main",
    channelId: "oc_chat_1",
    userId: "ou_user_1",
    sessionId: "oc_chat_1"
  });

  assert.equal(noteInbound.count, 1);
  assert.equal(store.listUnprocessedCoreMessagesForConversation("oc_chat_1", 10).length, 1);
  // No second outbound/system conversation message was inserted.
  assert.equal(store.listMessagesForConversation("oc_chat_1", 10).filter((entry) => entry.direction === "outbound").length, 0);
});

test("re-delivering the same pi invocation is a no-op for both message and send", async () => {
  const store = createAliceStore(path.join(makeTempDir("pi-completion-dedupe"), "alice.sqlite"));
  const sent: AgentOutput[] = [];
  const { runtime } = createRuntime({ store, sent });

  const input = {
    plugin: "feishu",
    conversationId: "oc_chat_1",
    piSessionId: "pi-session-1",
    piInvocationId: "pi-inv-1",
    text: "subagent finished"
  };
  await runtime.deliverPiInvocationCompletion(input);
  await runtime.deliverPiInvocationCompletion(input);

  assert.equal(store.listMessagesForConversation("oc_chat_1", 10).length, 1);
  assert.equal(sent.length, 1);
});

test("pi completion send failure marks the both message send_failed without blocking Core pending", async () => {
  const store = createAliceStore(path.join(makeTempDir("pi-completion-send-failed"), "alice.sqlite"));
  const { runtime, noteInbound } = createRuntime({
    store,
    sent: []
  });
  // Fail the send by replacing the router after creation.
  const failing = createMessageRuntime({
    getDelayMs: () => 60_000,
    getHeartbeatIntervalMs: () => 10_000,
    store,
    chatAgent: {
      async prepareEventRun() {
        return [];
      }
    },
    outputRouter: {
      async sendAll() {
        throw new Error("feishu send failed");
      }
    },
    agentState: {
      canReplyToInbound: () => true,
      canRunHeartbeat: () => true,
      getInboundDelayMs: () => 0,
      getSnapshot: () => ({ state: "waiting" }),
      onChange: () => () => {},
      noteInboundMessage() {
        noteInbound.count += 1;
        return undefined as never;
      },
      tick: () => undefined as never
    } as never,
    appendLog() {},
    appendMessageLog(entry) {
      return store.insertMessageLog({ time: new Date().toISOString(), ...entry });
    }
  });

  await failing.deliverPiInvocationCompletion({
    plugin: "feishu",
    conversationId: "oc_chat_1",
    piSessionId: "pi-session-1",
    piInvocationId: "pi-inv-1",
    text: "subagent finished",
    channelId: "oc_chat_1"
  });

  const messages = store.listMessagesForConversation("oc_chat_1", 10);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].status, "send_failed");
  assert.equal(messages[0].sendFailureReason, "feishu send failed");
  assert.equal(store.listUnprocessedCoreMessagesForConversation("oc_chat_1", 10).length, 1, "send failure does not consume the Core queue");
});

test("pi completion without a message target still lands in Core pending", async () => {
  const store = createAliceStore(path.join(makeTempDir("pi-completion-no-target"), "alice.sqlite"));
  const sent: AgentOutput[] = [];
  const { runtime, noteInbound } = createRuntime({ store, sent });

  await runtime.deliverPiInvocationCompletion({
    plugin: "web-admin",
    conversationId: "default",
    piSessionId: "pi-session-1",
    piInvocationId: "pi-inv-1",
    text: "background work done"
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].target.sessionId, "default");
  assert.equal(noteInbound.count, 1);
});
