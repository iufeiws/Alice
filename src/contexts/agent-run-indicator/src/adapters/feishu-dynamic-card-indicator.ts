import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import { createCurrentTimeProvider } from "../../../../platform/time/src/index.js";
import type { FeishuAgentRunCardBlock, FeishuDynamicCardClient } from "../../../../channels/feishu/src/types.js";
import type { FeishuPairingStore } from "../../../../channels/feishu/src/pairing.js";
import type { AgentRunIndicator, AgentRunIndicatorOutput, AgentRunIndicatorSession, AgentRunIndicatorToolCall } from "../ports.js";

const fs = await import("node:fs");
const path = await import("node:path");
const CARD_LAYOUT_VERSION = 5;
const TYPING_STATE_LABEL = "正在输入中...";

export type FeishuAgentRunIndicatorCardRecord = {
  messageId?: string;
  cardId?: string;
  layoutVersion?: number;
  nextSequence: number;
  updatedAt: string;
  state?: string;
  reasoning?: string;
  content?: string;
  tools?: string;
};

export type FeishuAgentRunIndicatorCardStore = {
  read(): FeishuAgentRunIndicatorCardRecord | undefined;
  write(record: FeishuAgentRunIndicatorCardRecord): void;
  delete(): void;
};

export type FeishuAgentRunIndicatorInput = {
  enabled(): boolean;
  client: FeishuDynamicCardClient;
  pairingStore: FeishuPairingStore;
  cardStore: FeishuAgentRunIndicatorCardStore;
  time?: CurrentTimeProvider;
  throttleMs?: number;
  getState?(): unknown;
  log?(level: "info" | "warn" | "error", message: string): void;
};

type ActiveCard = {
  messageId: string;
  cardId: string;
  nextSequence: number;
  blocks: IndicatorBlocks;
  savedBlocks: IndicatorBlocks;
};

type IndicatorBlocks = {
  state: string;
  reasoning: string;
  content: string;
  tools: string;
};

export function createJsonFeishuAgentRunIndicatorCardStore(filePath: string): FeishuAgentRunIndicatorCardStore {
  return {
    read() {
      if (!fs.existsSync(filePath)) return undefined;
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as FeishuAgentRunIndicatorCardRecord;
      if (!parsed.messageId && !parsed.cardId) return undefined;
      return {
        messageId: parsed.messageId,
        cardId: parsed.cardId,
        layoutVersion: parsed.layoutVersion,
        nextSequence: Number.isFinite(parsed.nextSequence) && parsed.nextSequence > 0 ? parsed.nextSequence : 1,
        updatedAt: parsed.updatedAt,
        state: parsed.state ?? "",
        reasoning: parsed.reasoning ?? "",
        content: parsed.content ?? "",
        tools: parsed.tools ?? ""
      };
    },
    write(record) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`);
    },
    delete() {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
  };
}

export function createFeishuDynamicCardAgentRunIndicator(input: FeishuAgentRunIndicatorInput): AgentRunIndicator {
  const time = input.time ?? createCurrentTimeProvider("UTC");
  const throttleMs = input.throttleMs ?? 500;

  return {
    async ensureReady() {
      if (!input.enabled() || !input.client.isStarted()) return;
      const receiveId = pairedFeishuUserId();
      if (!receiveId) return;
      await ensureCard(receiveId, { ...blocksFromRecord(input.cardStore.read() ?? {}), state: stateLabel(input.getState?.()) });
    },
    async createFreshCard() {
      if (!input.enabled() || !input.client.isStarted()) return;
      const receiveId = pairedFeishuUserId();
      if (!receiveId) return;
      await createCard(receiveId, { ...blocksFromRecord(input.cardStore.read() ?? {}), state: stateLabel(input.getState?.()) });
    },
    async begin() {
      if (!input.enabled() || !input.client.isStarted()) return undefined;
      const receiveId = pairedFeishuUserId();
      if (!receiveId) return undefined;

      let card = await ensureCard(receiveId);
      try {
        await updateStreaming(card, true);
        await updateState(card, TYPING_STATE_LABEL);
      } catch (error) {
        if (!isMissingCardError(error)) throw error;
        input.log?.("warn", "[agent-run-indicator] persisted Feishu card is unavailable; creating a new indicator card");
        card = await createCard(receiveId);
        await updateStreaming(card, true);
        await updateState(card, TYPING_STATE_LABEL);
      }
      return createSession(card);
    },
    async setTyping(typingInput) {
      if (!input.enabled() || !input.client.isStarted()) return;
      const receiveId = pairedFeishuUserId();
      if (!receiveId) return;
      const state = typingInput.typing ? TYPING_STATE_LABEL : stateLabel(input.getState?.());
      let card = typingInput.typing ? await ensureCard(receiveId, { ...emptyBlocks(), state }, { ...emptyBlocks(), state }) : await loadStoredCard();
      if (!card) return;
      try {
        await updateState(card, state);
      } catch (error) {
        if (!isMissingCardError(error)) throw error;
        input.cardStore.delete();
        if (!typingInput.typing) return;
        card = await createCard(receiveId, { ...emptyBlocks(), state }, { ...emptyBlocks(), state });
        await updateState(card, state);
      }
    }
  };

  function createSession(card: ActiveCard): AgentRunIndicatorSession {
    let reasoning = "";
    let content = "";
    let toolCalls = new Map<number, AgentRunIndicatorToolCall>();
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let flushPromise: Promise<void> = Promise.resolve();
    let failed = false;

    const clearFlushTimer = (): void => {
      if (!flushTimer) return;
      clearTimeout(flushTimer);
      flushTimer = undefined;
    };

    const queueFlush = (): void => {
      if (flushTimer || failed) return;
      flushTimer = setTimeout(() => {
        flushTimer = undefined;
        flushPromise = flushPromise
          .then(() => flushContent(card, runningBlocks(reasoning, content, toolCallsText(toolCalls))))
          .catch((error) => {
            failed = true;
            input.log?.("error", `[agent-run-indicator] Feishu indicator flush failed: ${errorMessage(error)}`);
          });
      }, throttleMs);
    };

    async function finishOutput(output: AgentRunIndicatorOutput): Promise<void> {
      clearFlushTimer();
      await flushPromise;
      reasoning = output.reasoning;
      content = output.content;
      toolCalls = toolCallsFromOutput(output.toolCalls);
    }

    return {
      async appendReasoningDelta(delta) {
        if (failed || !delta) return;
        reasoning += delta;
        queueFlush();
      },
      async appendContentDelta(delta) {
        if (failed || !delta) return;
        content += delta;
        queueFlush();
      },
      async appendToolCallDelta(delta) {
        if (failed) return;
        const current = toolCalls.get(delta.index) ?? { id: delta.id, name: "", arguments: "" };
        if (delta.id) current.id = delta.id;
        if (delta.name) current.name = delta.name;
        if (delta.arguments) current.arguments += delta.arguments;
        toolCalls.set(delta.index, current);
        queueFlush();
      },
      async finish(output) {
        if (failed) return;
        await finishOutput(output);
        const finalBlocks = {
          state: stateLabel(input.getState?.()),
          reasoning,
          content,
          tools: toolCallsText(toolCalls)
        };
        await updateBlocks(card, finalBlocks, finalBlocks);
        await updateStreaming(card, false);
      },
      async fail(error) {
        failed = true;
        clearFlushTimer();
        input.log?.("error", `[agent-run-indicator] Feishu indicator session failed: ${errorMessage(error)}`);
        try {
          await updateStreaming(card, false);
        } catch (finishError) {
          input.log?.("error", `[agent-run-indicator] Feishu indicator fail cleanup failed: ${errorMessage(finishError)}`);
        }
      }
    };
  }

  function pairedFeishuUserId(): string | undefined {
    const contacts = input.pairingStore.list();
    if (contacts.length !== 1) return undefined;
    return contacts[0].userId || undefined;
  }

  async function ensureCard(receiveId: string, initialBlocks = runningBlocks("", ""), savedBlocks = initialBlocks): Promise<ActiveCard> {
    const stored = input.cardStore.read();
    const card = await loadStoredCard(stored);
    if (card) return card;
    const storedBlocks = stored ? blocksFromRecord(stored) : emptyBlocks();
    return await createCard(receiveId, {
      ...storedBlocks,
      state: initialBlocks.state
    }, {
      ...storedBlocks,
      state: savedBlocks.state
    });
  }

  async function loadStoredCard(stored = input.cardStore.read()): Promise<ActiveCard | undefined> {
    if (stored && stored.layoutVersion !== CARD_LAYOUT_VERSION) return undefined;
    if (stored?.cardId) {
      const blocks = blocksFromRecord(stored);
      return {
        messageId: stored.messageId ?? "",
        cardId: stored.cardId,
        nextSequence: stored.nextSequence,
        blocks,
        savedBlocks: blocks
      };
    }

    if (stored?.messageId) {
      const converted = await input.client.resolveAgentRunCardId({ messageId: stored.messageId });
      if (converted.cardId) {
        const blocks = blocksFromRecord(stored);
        const record = {
          messageId: stored.messageId,
          cardId: converted.cardId,
          layoutVersion: CARD_LAYOUT_VERSION,
          nextSequence: stored.nextSequence,
          updatedAt: time.now().date.toISOString(),
          ...blocks
        };
        input.cardStore.write(record);
        return {
          messageId: record.messageId,
          cardId: record.cardId,
          nextSequence: record.nextSequence,
          blocks,
          savedBlocks: blocks
        };
      }
    }

    return undefined;
  }

  async function createCard(receiveId: string, blocks = runningBlocks("", ""), savedBlocks = blocks): Promise<ActiveCard> {
    const created = await input.client.createAgentRunCard({
      receiveIdType: "open_id",
      receiveId,
      blocks
    });
    const card = {
      messageId: created.messageId,
      cardId: created.cardId,
      nextSequence: 1,
      blocks,
      savedBlocks
    };
    persistCard(card);
    return card;
  }

  async function updateStreaming(card: ActiveCard, enabled: boolean): Promise<void> {
    await callCardOperation(card, () => input.client.setAgentRunCardStreaming({
      cardId: card.cardId,
      enabled,
      sequence: card.nextSequence
    }));
  }

  async function updateBlock(card: ActiveCard, block: FeishuAgentRunCardBlock, content: string, nextBlocks?: IndicatorBlocks, nextSavedBlocks?: IndicatorBlocks): Promise<void> {
    await callCardOperation(card, () => input.client.updateAgentRunCardBlocks({
      cardId: card.cardId,
      blocks: { [block]: content },
      sequence: card.nextSequence
    }), nextBlocks, nextSavedBlocks);
  }

  async function updateState(card: ActiveCard, state: string): Promise<void> {
    await updateBlock(card, "state", state, { ...card.blocks, state }, { ...card.savedBlocks, state });
  }

  async function updateBlocks(card: ActiveCard, blocks: IndicatorBlocks, nextSavedBlocks?: IndicatorBlocks): Promise<void> {
    await callCardOperation(card, () => input.client.updateAgentRunCardBlocks({
      cardId: card.cardId,
      blocks,
      sequence: card.nextSequence
    }), blocks, nextSavedBlocks);
  }

  async function flushContent(card: ActiveCard, blocks: IndicatorBlocks): Promise<void> {
    await updateBlocks(card, blocks);
  }

  async function callCardOperation(card: ActiveCard, operation: () => Promise<void>, nextBlocks?: IndicatorBlocks, nextSavedBlocks?: IndicatorBlocks): Promise<void> {
    try {
      await operation();
      card.nextSequence += 1;
      if (nextBlocks) card.blocks = nextBlocks;
      if (nextSavedBlocks) card.savedBlocks = nextSavedBlocks;
      persistCard(card);
    } catch (error) {
      if (isMissingCardError(error)) input.cardStore.delete();
      throw error;
    }
  }

  function persistCard(card: ActiveCard): void {
    input.cardStore.write({
      messageId: card.messageId,
      cardId: card.cardId,
      layoutVersion: CARD_LAYOUT_VERSION,
      nextSequence: card.nextSequence,
      updatedAt: time.now().date.toISOString(),
      ...card.savedBlocks
    });
  }
}

function runningBlocks(reasoning: string, content: string, tools = ""): IndicatorBlocks {
  return {
    state: TYPING_STATE_LABEL,
    reasoning,
    content,
    tools
  };
}

function emptyBlocks(): IndicatorBlocks {
  return {
    state: "",
    reasoning: "",
    content: "",
    tools: ""
  };
}

function blocksFromRecord(record: Pick<FeishuAgentRunIndicatorCardRecord, "state" | "reasoning" | "content" | "tools">): IndicatorBlocks {
  return {
    state: record.state ?? "",
    reasoning: record.reasoning ?? "",
    content: record.content ?? "",
    tools: record.tools ?? ""
  };
}

function toolCallsFromOutput(calls: AgentRunIndicatorToolCall[]): Map<number, AgentRunIndicatorToolCall> {
  return new Map(calls.map((call, index) => [index, { ...call }]));
}

function toolCallsText(calls: Map<number, AgentRunIndicatorToolCall>): string {
  return [...calls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, call]) => formatToolCall(call))
    .filter(Boolean)
    .join("\n");
}

function formatToolCall(call: AgentRunIndicatorToolCall): string {
  return [call.name, call.arguments].filter(Boolean).join(" ");
}

function stateLabel(value: unknown): string {
  if (value && typeof value === "object" && "state" in value && typeof value.state === "string") return value.state;
  return "idle";
}

function isMissingCardError(error: unknown): boolean {
  const message = errorMessage(error);
  return /not\s*exist|not\s*found|does\s*not\s*exist|cannot\s*be\s*updated|deleted|invalid\s*card/i.test(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
