import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChatAgentLoop, type ChatAgentLoopInput, type ChatAgentLoopSession } from "../src/contexts/agent-loop/src/application/run-chat-loop.js";
import { runAgentFunctionCallLoop } from "../src/contexts/agent-loop/src/runtime/agent-loop-runtime.js";
import { createCurrentTimeProvider } from "../src/platform/time/src/index.js";
import {
  createFeishuDynamicCardAgentRunIndicator,
  type FeishuAgentRunIndicatorCardRecord,
  type FeishuAgentRunIndicatorCardStore
} from "../src/contexts/agent-run-indicator/src/index.js";
import type { AgentEvent } from "../src/contexts/agent-loop/src/contracts/agent-contracts.js";
import type { AgentRunIndicator, AgentRunIndicatorSession } from "../src/contexts/agent-run-indicator/src/index.js";
import type { FeishuDynamicCardClient } from "../src/channels/feishu/src/types.js";
import type { FeishuPairingStore } from "../src/channels/feishu/src/pairing.js";

const CARD_LAYOUT_VERSION = 4;

test("chat loop behaves unchanged when no agent run indicator is configured", async () => {
  const sentRequests: string[] = [];
  const loop = buildChatAgentLoop(loopInput({
    llmRequestSender: async (request) => {
      sentRequests.push(request.agentId);
      return { message: { role: "assistant", content: "ok" } };
    }
  }));

  const result = await runAgentFunctionCallLoop(loop.spec);

  assert.equal(result.finalMessage.content, "ok");
  assert.deepEqual(sentRequests, ["chat"]);
});

test("chat loop forwards stream content deltas to indicator and preserves existing stream handler", async () => {
  const calls: string[] = [];
  const indicator: AgentRunIndicator = {
    async begin(input) {
      calls.push(`begin:${input.agentId}:${input.round}`);
      return {
        async appendReasoningDelta(delta) {
          calls.push(`reasoning:${delta}`);
        },
        async appendContentDelta(delta) {
          calls.push(`indicator:${delta}`);
        },
        async finish() {
          calls.push("finish");
        },
        async fail(error) {
          calls.push(`fail:${error instanceof Error ? error.message : String(error)}`);
        }
      };
    }
  };
  const loop = buildChatAgentLoop(loopInput({
    agentRunIndicator: indicator,
    llmInput: {
      streamHandlers: {
        onContentDelta(delta) {
          calls.push(`existing:${delta}`);
        }
      }
    },
    llmRequestSender: async (request) => {
      await request.streamHandlers?.onReasoningDelta?.("think");
      await request.streamHandlers?.onContentDelta?.("he");
      await request.streamHandlers?.onContentDelta?.("llo");
      return { message: { role: "assistant", content: "hello" } };
    }
  }));

  const result = await runAgentFunctionCallLoop(loop.spec);

  assert.equal(result.finalMessage.content, "hello");
  assert.deepEqual(calls, [
    "begin:chat:0",
    "reasoning:think",
    "existing:he",
    "indicator:he",
    "existing:llo",
    "indicator:llo",
    "finish"
  ]);
});

test("chat loop disables current indicator session after indicator delta failure", async () => {
  const errors: string[] = [];
  const calls: string[] = [];
  const session: AgentRunIndicatorSession = {
    async appendReasoningDelta(delta) {
      calls.push(`reasoning:${delta}`);
    },
    async appendContentDelta(delta) {
      calls.push(`delta:${delta}`);
      throw new Error("indicator_down");
    },
    async finish() {
      calls.push("finish");
    },
    async fail(error) {
      calls.push(`fail:${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const loop = buildChatAgentLoop(loopInput({
    agentRunIndicator: {
      async begin() {
        return session;
      }
    },
    onAgentRunIndicatorError(error) {
      errors.push(error instanceof Error ? error.message : String(error));
    },
    llmRequestSender: async (request) => {
      await request.streamHandlers?.onContentDelta?.("a");
      await request.streamHandlers?.onContentDelta?.("b");
      return { message: { role: "assistant", content: "ab" } };
    }
  }));

  await runAgentFunctionCallLoop(loop.spec);

  assert.deepEqual(calls, ["delta:a", "fail:indicator_down"]);
  assert.deepEqual(errors, ["indicator_down"]);
});

test("Feishu agent run indicator creates a card when no persisted card exists and flushes final content", async () => {
  const store = memoryCardStore();
  const client = fakeCardClient();
  const indicator = createFeishuDynamicCardAgentRunIndicator({
    enabled: () => true,
    client,
    pairingStore: pairedStore(),
    cardStore: store,
    time: createCurrentTimeProvider("UTC", () => new Date("2026-06-29T00:00:00.000Z")),
    throttleMs: 10_000,
    getState: () => ({ state: "working" })
  });

  const session = await indicator.begin({ round: 0 });
  assert.ok(session);
  await session.appendContentDelta("he");
  await session.appendReasoningDelta("think");
  await session.appendContentDelta("llo");
  await session.finish();

  assert.deepEqual(client.calls, [
    "create:ou_user:正在输入中...||",
    "stream:card_new:true:1",
    "update:card_new:state:正在输入中...:2",
    "update:card_new:state:正在输入中...:3",
    "update:card_new:reasoning:think:4",
    "update:card_new:content:hello:5",
    "update:card_new:state:working:6",
    "update:card_new:reasoning:think:7",
    "update:card_new:content:hello:8",
    "stream:card_new:false:9"
  ]);
  assert.deepEqual(store.read(), {
    messageId: "om_new",
    cardId: "card_new",
    layoutVersion: CARD_LAYOUT_VERSION,
    nextSequence: 10,
    updatedAt: "2026-06-29T00:00:00.000Z",
    state: "working",
    reasoning: "think",
    content: "hello"
  });
});

test("Feishu agent run indicator reuses persisted card and preserves empty block positions", async () => {
  const store = memoryCardStore({
    messageId: "om_old",
    cardId: "card_old",
    layoutVersion: CARD_LAYOUT_VERSION,
    nextSequence: 7,
    updatedAt: "2026-06-28T00:00:00.000Z"
  });
  const client = fakeCardClient();
  const indicator = createFeishuDynamicCardAgentRunIndicator({
    enabled: () => true,
    client,
    pairingStore: pairedStore(),
    cardStore: store,
    time: createCurrentTimeProvider("UTC", () => new Date("2026-06-29T00:00:00.000Z")),
    throttleMs: 10_000,
    getState: () => ({ state: "waiting", last: "raw" })
  });

  const session = await indicator.begin({ round: 0 });
  assert.ok(session);
  await session.finish();

  assert.deepEqual(client.calls, [
    "stream:card_old:true:7",
    "update:card_old:state:正在输入中...:8",
    "update:card_old:state:正在输入中...:9",
    "update:card_old:reasoning::10",
    "update:card_old:content::11",
    "update:card_old:state:waiting:12",
    "update:card_old:reasoning::13",
    "update:card_old:content::14",
    "stream:card_old:false:15"
  ]);
  assert.deepEqual(store.read(), {
    messageId: "om_old",
    cardId: "card_old",
    layoutVersion: CARD_LAYOUT_VERSION,
    nextSequence: 16,
    updatedAt: "2026-06-29T00:00:00.000Z",
    state: "waiting",
    reasoning: "",
    content: ""
  });
});

test("Feishu agent run indicator clears previous blocks on streamed content", async () => {
  const store = memoryCardStore({
    messageId: "om_old",
    cardId: "card_old",
    layoutVersion: CARD_LAYOUT_VERSION,
    nextSequence: 7,
    updatedAt: "2026-06-28T00:00:00.000Z",
    state: "idle",
    reasoning: "reasoning",
    content: "content"
  });
  const client = fakeCardClient();
  const indicator = createFeishuDynamicCardAgentRunIndicator({
    enabled: () => true,
    client,
    pairingStore: pairedStore(),
    cardStore: store,
    time: createCurrentTimeProvider("UTC", () => new Date("2026-06-29T00:00:00.000Z")),
    throttleMs: 10_000,
    getState: () => ({ state: "waiting" })
  });

  const session = await indicator.begin({ round: 0 });
  assert.ok(session);
  await session.appendReasoningDelta("c");
  await session.appendContentDelta("co");
  await session.finish();

  assert.deepEqual(client.calls, [
    "stream:card_old:true:7",
    "update:card_old:state:正在输入中...:8",
    "update:card_old:state:正在输入中...:9",
    "update:card_old:reasoning:c:10",
    "update:card_old:content:co:11",
    "update:card_old:state:waiting:12",
    "update:card_old:reasoning:c:13",
    "update:card_old:content:co:14",
    "stream:card_old:false:15"
  ]);
  assert.deepEqual(store.read(), {
    messageId: "om_old",
    cardId: "card_old",
    layoutVersion: CARD_LAYOUT_VERSION,
    nextSequence: 16,
    updatedAt: "2026-06-29T00:00:00.000Z",
    state: "waiting",
    reasoning: "c",
    content: "co"
  });
});

test("Feishu agent run indicator streams current content while saving clean final blocks", async () => {
  const store = memoryCardStore({
    messageId: "om_old",
    cardId: "card_old",
    layoutVersion: CARD_LAYOUT_VERSION,
    nextSequence: 7,
    updatedAt: "2026-06-28T00:00:00.000Z",
    state: "idle",
    reasoning: "reasoning",
    content: "content"
  });
  const client = fakeCardClient();
  const indicator = createFeishuDynamicCardAgentRunIndicator({
    enabled: () => true,
    client,
    pairingStore: pairedStore(),
    cardStore: store,
    time: createCurrentTimeProvider("UTC", () => new Date("2026-06-29T00:00:00.000Z")),
    throttleMs: 0,
    getState: () => ({ state: "waiting" })
  });

  const session = await indicator.begin({ round: 0 });
  assert.ok(session);
  await session.appendReasoningDelta("c");
  await session.appendContentDelta("c");
  await delay(5);
  assert.deepEqual(store.read(), {
    messageId: "om_old",
    cardId: "card_old",
    layoutVersion: CARD_LAYOUT_VERSION,
    nextSequence: 12,
    updatedAt: "2026-06-29T00:00:00.000Z",
    state: "正在输入中...",
    reasoning: "reasoning",
    content: "content"
  });
  await session.appendReasoningDelta("o");
  await session.appendContentDelta("o");
  await session.finish();

  assert.deepEqual(client.calls, [
    "stream:card_old:true:7",
    "update:card_old:state:正在输入中...:8",
    "update:card_old:state:正在输入中...:9",
    "update:card_old:reasoning:c:10",
    "update:card_old:content:c:11",
    "update:card_old:state:正在输入中...:12",
    "update:card_old:reasoning:co:13",
    "update:card_old:content:co:14",
    "update:card_old:state:waiting:15",
    "update:card_old:reasoning:co:16",
    "update:card_old:content:co:17",
    "stream:card_old:false:18"
  ]);
  assert.deepEqual(store.read(), {
    messageId: "om_old",
    cardId: "card_old",
    layoutVersion: CARD_LAYOUT_VERSION,
    nextSequence: 19,
    updatedAt: "2026-06-29T00:00:00.000Z",
    state: "waiting",
    reasoning: "co",
    content: "co"
  });
});

test("Feishu agent run indicator follows project typing state", async () => {
  const store = memoryCardStore({
    messageId: "om_old",
    cardId: "card_old",
    layoutVersion: CARD_LAYOUT_VERSION,
    nextSequence: 7,
    updatedAt: "2026-06-28T00:00:00.000Z",
    state: "idle",
    reasoning: "think",
    content: "hello"
  });
  const client = fakeCardClient();
  const indicator = createFeishuDynamicCardAgentRunIndicator({
    enabled: () => true,
    client,
    pairingStore: pairedStore(),
    cardStore: store,
    time: createCurrentTimeProvider("UTC", () => new Date("2026-06-29T00:00:00.000Z")),
    getState: () => ({ state: "waiting" })
  });

  await indicator.setTyping?.({ typing: true });
  await indicator.setTyping?.({ typing: false });

  assert.deepEqual(client.calls, [
    "update:card_old:state:正在输入中...:7",
    "update:card_old:state:waiting:8"
  ]);
  assert.deepEqual(store.read(), {
    messageId: "om_old",
    cardId: "card_old",
    layoutVersion: CARD_LAYOUT_VERSION,
    nextSequence: 9,
    updatedAt: "2026-06-29T00:00:00.000Z",
    state: "waiting",
    reasoning: "think",
    content: "hello"
  });
});

test("Feishu agent run indicator creates a card on project typing start", async () => {
  const store = memoryCardStore();
  const client = fakeCardClient();
  const indicator = createFeishuDynamicCardAgentRunIndicator({
    enabled: () => true,
    client,
    pairingStore: pairedStore(),
    cardStore: store,
    time: createCurrentTimeProvider("UTC", () => new Date("2026-06-29T00:00:00.000Z")),
    getState: () => ({ state: "waiting" })
  });

  await indicator.setTyping?.({ typing: true });

  assert.deepEqual(client.calls, [
    "create:ou_user:正在输入中...||",
    "update:card_new:state:正在输入中...:1"
  ]);
  assert.deepEqual(store.read(), {
    messageId: "om_new",
    cardId: "card_new",
    layoutVersion: CARD_LAYOUT_VERSION,
    nextSequence: 2,
    updatedAt: "2026-06-29T00:00:00.000Z",
    state: "正在输入中...",
    reasoning: "",
    content: ""
  });
});

test("Feishu agent run indicator recreates old layout cards and keeps saved thinking", async () => {
  const store = memoryCardStore({
    messageId: "om_old",
    cardId: "card_old",
    nextSequence: 7,
    updatedAt: "2026-06-28T00:00:00.000Z",
    state: "idle",
    reasoning: "old think",
    content: "old answer"
  });
  const client = fakeCardClient();
  const indicator = createFeishuDynamicCardAgentRunIndicator({
    enabled: () => true,
    client,
    pairingStore: pairedStore(),
    cardStore: store,
    time: createCurrentTimeProvider("UTC", () => new Date("2026-06-29T00:00:00.000Z")),
    getState: () => ({ state: "waiting" })
  });

  await indicator.setTyping?.({ typing: true });

  assert.deepEqual(client.calls, [
    "create:ou_user:正在输入中...|old think|old answer",
    "update:card_new:state:正在输入中...:1"
  ]);
  assert.deepEqual(store.read(), {
    messageId: "om_new",
    cardId: "card_new",
    layoutVersion: CARD_LAYOUT_VERSION,
    nextSequence: 2,
    updatedAt: "2026-06-29T00:00:00.000Z",
    state: "正在输入中...",
    reasoning: "old think",
    content: "old answer"
  });
});

test("Feishu agent run indicator recreates old layout cards during startup ensure", async () => {
  const store = memoryCardStore({
    messageId: "om_old",
    cardId: "card_old",
    nextSequence: 7,
    updatedAt: "2026-06-28T00:00:00.000Z",
    state: "idle",
    reasoning: "old think",
    content: "old answer"
  });
  const client = fakeCardClient();
  const indicator = createFeishuDynamicCardAgentRunIndicator({
    enabled: () => true,
    client,
    pairingStore: pairedStore(),
    cardStore: store,
    time: createCurrentTimeProvider("UTC", () => new Date("2026-06-29T00:00:00.000Z")),
    getState: () => ({ state: "waiting" })
  });

  await indicator.ensureReady?.();

  assert.deepEqual(client.calls, [
    "create:ou_user:waiting|old think|old answer"
  ]);
  assert.deepEqual(store.read(), {
    messageId: "om_new",
    cardId: "card_new",
    layoutVersion: CARD_LAYOUT_VERSION,
    nextSequence: 1,
    updatedAt: "2026-06-29T00:00:00.000Z",
    state: "waiting",
    reasoning: "old think",
    content: "old answer"
  });
});

test("Feishu agent run indicator creates a fresh card on demand", async () => {
  const store = memoryCardStore({
    messageId: "om_old",
    cardId: "card_old",
    layoutVersion: CARD_LAYOUT_VERSION,
    nextSequence: 7,
    updatedAt: "2026-06-28T00:00:00.000Z",
    state: "idle",
    reasoning: "old think",
    content: "old answer"
  });
  const client = fakeCardClient();
  const indicator = createFeishuDynamicCardAgentRunIndicator({
    enabled: () => true,
    client,
    pairingStore: pairedStore(),
    cardStore: store,
    time: createCurrentTimeProvider("UTC", () => new Date("2026-06-29T00:00:00.000Z")),
    getState: () => ({ state: "waiting" })
  });

  await indicator.createFreshCard?.();

  assert.deepEqual(client.calls, [
    "create:ou_user:waiting|old think|old answer"
  ]);
  assert.deepEqual(store.read(), {
    messageId: "om_new",
    cardId: "card_new",
    layoutVersion: CARD_LAYOUT_VERSION,
    nextSequence: 1,
    updatedAt: "2026-06-29T00:00:00.000Z",
    state: "waiting",
    reasoning: "old think",
    content: "old answer"
  });
});

test("Feishu agent run indicator is unavailable without a unique paired open_id target", async () => {
  const client = fakeCardClient();
  const indicator = createFeishuDynamicCardAgentRunIndicator({
    enabled: () => true,
    client,
    pairingStore: pairedStore({ contacts: [] }),
    cardStore: memoryCardStore()
  });

  assert.equal(await indicator.begin({ round: 0 }), undefined);
  assert.deepEqual(client.calls, []);
});

function loopInput(overrides: {
  llmRequestSender?: ChatAgentLoopInput["llmRequestSender"];
  agentRunIndicator?: AgentRunIndicator;
  onAgentRunIndicatorError?: (error: unknown) => void;
  llmInput?: Partial<ChatAgentLoopInput["llmInput"]>;
} = {}): ChatAgentLoopInput {
  const session: ChatAgentLoopSession = {
    messages: [{ role: "user", content: "hello" }],
    requestTimestamps: [],
    mode: "default"
  };
  return {
    llmInput: {
      messages: session.messages,
      toolNames: [],
      stream: true,
      ...overrides.llmInput
    },
    event: textEvent(),
    toolPlugins: [],
    session,
    ensureSession: async () => session,
    appendSessionContext: async () => {},
    llm: {
      async chat() {
        return { message: { role: "assistant", content: "ok" } };
      }
    },
    llmRequestSender: overrides.llmRequestSender,
    time: createCurrentTimeProvider("UTC", () => new Date("2026-06-29T00:00:00.000Z")),
    buildTextVariables: () => ({}),
    noteSessionUpdated() {},
    getLastCompletedToolName: () => undefined,
    setLastCompletedToolName() {},
    applyModeStateToNewSession() {},
    agentRunIndicator: overrides.agentRunIndicator,
    onAgentRunIndicatorError: overrides.onAgentRunIndicatorError
  };
}

function textEvent(): AgentEvent {
  return {
    id: "evt_1",
    source: {
      plugin: "test",
      userId: "user_1"
    },
    externalSession: {
      scope: "dm",
      sessionId: "session_1"
    },
    type: "message.text",
    payload: {
      kind: "text",
      text: "hello"
    },
    meta: {
      receivedAt: "2026-06-29T00:00:00.000Z"
    }
  };
}

function memoryCardStore(initial?: FeishuAgentRunIndicatorCardRecord): FeishuAgentRunIndicatorCardStore {
  let record = initial;
  return {
    read: () => record,
    write(next) {
      record = { ...next };
    },
    delete() {
      record = undefined;
    }
  };
}

function fakeCardClient(): FeishuDynamicCardClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    isStarted: () => true,
    async createAgentRunCard(input) {
      calls.push(`create:${input.receiveId}:${input.blocks.state}|${input.blocks.reasoning}|${input.blocks.content}`);
      return { messageId: "om_new", cardId: "card_new" };
    },
    async updateAgentRunCard(input) {
      calls.push(`update:${input.cardId}:${input.block}:${input.content}:${input.sequence}`);
    },
    async setAgentRunCardStreaming(input) {
      calls.push(`stream:${input.cardId}:${input.enabled}:${input.sequence}`);
    },
    async resolveAgentRunCardId(input) {
      calls.push(`convert:${input.messageId}`);
      return { cardId: "card_converted" };
    }
  };
}

function pairedStore(input: { contacts?: ReturnType<FeishuPairingStore["list"]> } = {}): FeishuPairingStore {
  const contacts = input.contacts ?? [{
    id: "feishu:dm:ou_user",
    plugin: "feishu" as const,
    userId: "ou_user",
    channelId: "oc_chat",
    sessionId: "feishu:dm:ou_user",
    scope: "dm" as const,
    pairedAt: "2026-06-29T00:00:00.000Z",
    lastSeenAt: "2026-06-29T00:00:00.000Z",
    canInitiate: true
  }];
  return {
    list: () => contacts,
    isPaired: () => true,
    pairFromEvent() {
      throw new Error("not expected");
    }
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
