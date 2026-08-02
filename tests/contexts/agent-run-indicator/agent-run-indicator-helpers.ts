import assert from "node:assert/strict";
import { buildChatAgentLoop, type ChatAgentLoopInput, type ChatAgentLoopSession } from "../../../src/contexts/agent-loop/src/application/run-chat-loop.js";
import { createCurrentTimeProvider } from "../../../src/platform/time/src/index.js";
import type { AgentEvent, ToolPlugin } from "../../../src/contexts/agent-loop/src/contracts/agent-contracts.js";
import {
  createFeishuDynamicCardAgentRunIndicator,
  type AgentRunIndicator,
  type FeishuAgentRunIndicatorCardRecord,
  type FeishuAgentRunIndicatorCardStore
} from "../../../src/contexts/agent-run-indicator/src/index.js";
import type { FeishuDynamicCardClient } from "../../../src/channels/feishu/src/types.js";
import type { FeishuPairingStore } from "../../../src/channels/feishu/src/pairing.js";
import { registerLLMToolLoopTools } from "../../../src/contexts/llm-gateway/src/llm-tool-loop.js";
import { testPromptRuntime } from "../../helpers/prompt-runtime.js";

export const CARD_LAYOUT_VERSION = 5;
export const fixedNow = "2026-06-29T00:00:00.000Z";

type CardBlocks = {
  state: string;
  reasoning: string;
  content: string;
  tools: string;
};

export type CardCall =
  | { kind: "create"; receiveId: string; blocks: CardBlocks }
  | { kind: "update-blocks"; cardId: string; blocks: Partial<CardBlocks>; sequence: number }
  | { kind: "stream"; cardId: string; enabled: boolean; sequence: number }
  | { kind: "convert"; messageId: string }
  | { kind: "tool-create"; receiveId: string; toolName: string }
  | { kind: "tool-append"; cardId: string; toolName: string; sequence: number }
  | { kind: "tool-update"; cardId: string; block: string; content: string; sequence: number }
  | { kind: "tool-stream"; cardId: string; enabled: boolean; sequence: number };

export function loopInput(overrides: {
  llmRequestSender?: ChatAgentLoopInput["llmRequestSender"];
  agentRunIndicator?: AgentRunIndicator;
  onAgentRunIndicatorError?: (error: unknown) => void;
  llmInput?: Partial<ChatAgentLoopInput["llmInput"]>;
  toolPlugins?: ToolPlugin[];
} = {}): ChatAgentLoopInput {
  registerLLMToolLoopTools("default", overrides.toolPlugins ?? []);
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
      assistantContentToolCall: {
        mode: "never",
        toolName: "Chat",
        input: { action: "send", type: "message" },
        contentInputKey: "content"
      },
      ...overrides.llmInput
    },
    event: textEvent(),
    session,
    ensureSession: async () => session,
    appendSessionContext: async () => {},
    llm: {
      async chat() {
        return { message: { role: "assistant", content: "ok" } };
      }
    },
    llmRequestSender: overrides.llmRequestSender ?? (async () => ({ message: { role: "assistant", content: "ok" } })),
    time: createCurrentTimeProvider("UTC", () => new Date(fixedNow)),
    buildTextVariables: () => testPromptRuntime(),
    noteSessionUpdated() {},
    getLastCompletedToolName: () => undefined,
    setLastCompletedToolName() {},
    applyModeStateToNewSession() {},
    agentRunIndicator: overrides.agentRunIndicator,
    onAgentRunIndicatorError: overrides.onAgentRunIndicatorError
  };
}

export function demoToolPlugin(): ToolPlugin {
  return {
    id: "demo",
    listTools: () => [{ name: "Demo", description: "demo", inputSchema: { type: "object" } }],
    async execute(call) {
      return { callId: call.id, ok: true, output: "ok" };
    }
  };
}

export function memoryCardStore(initial?: FeishuAgentRunIndicatorCardRecord): FeishuAgentRunIndicatorCardStore {
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

export function fakeCardClient(): FeishuDynamicCardClient & { calls: CardCall[] } {
  const calls: CardCall[] = [];
  return {
    calls,
    isStarted: () => true,
    async createApprovalCard() {
      throw new Error("unused");
    },
    async deleteMessage() {
      throw new Error("unused");
    },
    async createAgentRunCard(input) {
      calls.push({ kind: "create", receiveId: input.receiveId, blocks: { ...input.blocks } });
      return { messageId: "om_new", cardId: "card_new" };
    },
    async updateAgentRunCardBlocks(input) {
      calls.push({
        kind: "update-blocks",
        cardId: input.cardId,
        blocks: { ...input.blocks },
        sequence: input.sequence
      });
    },
    async setAgentRunCardStreaming(input) {
      calls.push({ kind: "stream", cardId: input.cardId, enabled: input.enabled, sequence: input.sequence });
    },
    async resolveAgentRunCardId(input) {
      calls.push({ kind: "convert", messageId: input.messageId });
      return { cardId: "card_converted" };
    },
    async createToolExecutionCard(input) {
      calls.push({ kind: "tool-create", receiveId: input.receiveId, toolName: input.toolName });
      return { messageId: "om_tool", cardId: "card_tool" };
    },
    async groupToolExecutionCard(input) {
      calls.push({ kind: "tool-append", cardId: input.cardId, toolName: input.panels.at(-1)?.toolName ?? "", sequence: input.sequence });
    },
    async updateToolExecutionCard(input) {
      calls.push({
        kind: "tool-update",
        cardId: input.cardId,
        block: input.block,
        content: input.content,
        sequence: input.sequence
      });
    },
    async setToolExecutionCardStreaming(input) {
      calls.push({ kind: "tool-stream", cardId: input.cardId, enabled: input.enabled, sequence: input.sequence });
    }
  };
}

export function pairedStore(input: { contacts?: ReturnType<FeishuPairingStore["list"]> } = {}): FeishuPairingStore {
  const contacts = input.contacts ?? [{
    id: "feishu:dm:ou_user",
    plugin: "feishu" as const,
    userId: "ou_user",
    channelId: "oc_chat",
    sessionId: "feishu:dm:ou_user",
    scope: "dm" as const,
    pairedAt: fixedNow,
    lastSeenAt: fixedNow,
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

export function createTestFeishuIndicator(input: {
  enabled?: () => boolean;
  client: FeishuDynamicCardClient;
  pairingStore?: FeishuPairingStore;
  cardStore: FeishuAgentRunIndicatorCardStore;
  throttleMs?: number;
  getState?: () => { state: string; last?: string };
}) {
  return createFeishuDynamicCardAgentRunIndicator({
    enabled: input.enabled ?? (() => true),
    client: input.client,
    pairingStore: input.pairingStore ?? pairedStore(),
    cardStore: input.cardStore,
    time: createCurrentTimeProvider("UTC", () => new Date(fixedNow)),
    throttleMs: input.throttleMs,
    getState: input.getState ?? (() => ({ state: "waiting" }))
  });
}

export function assertCreatedCard(client: { calls: CardCall[] }, blocks: CardBlocks): void {
  const create = client.calls.find((call): call is Extract<CardCall, { kind: "create" }> => call.kind === "create");
  assert.ok(create);
  assert.equal(create.receiveId, "ou_user");
  assert.deepEqual(create.blocks, blocks);
}

export function assertUpdateIncludes(client: { calls: CardCall[] }, block: string, content: string): void {
  assert.ok(client.calls.some(
    (call) => call.kind === "update-blocks" && call.blocks[block as keyof CardBlocks] === content
  ));
}

export function assertStreamState(client: { calls: CardCall[] }, enabled: boolean): void {
  assert.ok(client.calls.some((call) => call.kind === "stream" && call.enabled === enabled));
}

export function assertCardRecord(
  store: FeishuAgentRunIndicatorCardStore,
  expected: Omit<FeishuAgentRunIndicatorCardRecord, "nextSequence">
): void {
  const record = store.read();
  assert.ok(record);
  const { nextSequence: _nextSequence, ...stableRecord } = record;
  assert.deepEqual(stableRecord, expected);
}

export function textEvent(): AgentEvent {
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
      receivedAt: fixedNow
    }
  };
}

export async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("condition was not met before timeout");
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
